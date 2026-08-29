"""SharePoint connector: delta sync (multi-page, catch-up), webhook handling
with clientState validation, and subscription renewal -- all against
`FakeGraphClient`, no network access."""

from __future__ import annotations

import hmac
from datetime import UTC, datetime, timedelta

import pytest

import trialpulse_ingest.sharepoint as sharepoint_module
from trialpulse_ingest.sharepoint import (
    DeltaItem,
    DeltaPage,
    DeltaSyncOverflowError,
    FakeGraphClient,
    GraphSubscription,
    IngestionJob,
    InMemoryDeltaLinkStore,
    SharePointConnector,
    SuspiciousGraphUrlError,
)

SITE_ID = "site-1"
DRIVE_ID = "drive-1"
INITIAL_URL = "https://graph.microsoft.com/v1.0/sites/site-1/drives/drive-1/root/delta"


def _connector(graph_client: FakeGraphClient) -> tuple[SharePointConnector, list[IngestionJob]]:
    enqueued: list[IngestionJob] = []
    connector = SharePointConnector(graph_client, InMemoryDeltaLinkStore(), enqueue=enqueued.append)
    return connector, enqueued


def test_delta_sync_single_page_enqueues_changed_items() -> None:
    graph_client = FakeGraphClient()
    now = datetime.now(UTC)
    graph_client.pages[INITIAL_URL] = DeltaPage(
        items=[
            DeltaItem("item-1", "protocol.md", "https://sp/protocol.md", is_deleted=False, last_modified=now),
            DeltaItem("item-2", "ib.md", "https://sp/ib.md", is_deleted=False, last_modified=now),
        ],
        next_link=None,
        delta_link="https://graph.microsoft.com/v1.0/.../delta?token=abc",
    )
    connector, enqueued = _connector(graph_client)

    result = connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)

    assert len(result.changed) == 2
    assert result.deleted == []
    assert result.enqueued == 2
    assert [job.item_id for job in enqueued] == ["item-1", "item-2"]
    assert all(job.reason == "delta_sync" for job in enqueued)


def test_delta_sync_follows_next_link_across_multiple_pages() -> None:
    graph_client = FakeGraphClient()
    page_2_url = "https://graph.microsoft.com/v1.0/.../delta?skip=1"
    graph_client.pages[INITIAL_URL] = DeltaPage(
        items=[DeltaItem("item-1", "a.md", "url", False, datetime.now(UTC))],
        next_link=page_2_url,
        delta_link=None,
    )
    graph_client.pages[page_2_url] = DeltaPage(
        items=[DeltaItem("item-2", "b.md", "url", False, datetime.now(UTC))],
        next_link=None,
        delta_link="https://graph.microsoft.com/v1.0/.../delta?token=final",
    )
    connector, enqueued = _connector(graph_client)

    result = connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)

    assert [job.item_id for job in enqueued] == ["item-1", "item-2"]
    assert result.enqueued == 2


def test_delta_sync_persists_delta_link_for_next_run() -> None:
    graph_client = FakeGraphClient()
    delta_link = "https://graph.microsoft.com/v1.0/.../delta?token=persisted"
    graph_client.pages[INITIAL_URL] = DeltaPage(items=[], next_link=None, delta_link=delta_link)
    delta_store = InMemoryDeltaLinkStore()
    connector = SharePointConnector(graph_client, delta_store, enqueue=lambda job: None)

    connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)

    assert delta_store.get(DRIVE_ID) == delta_link

    # Second run should start from the persisted delta link, not the initial URL.
    graph_client.pages[delta_link] = DeltaPage(
        items=[DeltaItem("item-3", "c.md", "url", False, datetime.now(UTC))],
        next_link=None,
        delta_link="https://graph.microsoft.com/v1.0/.../delta?token=persisted-2",
    )
    result = connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)
    assert [item.item_id for item in result.changed] == ["item-3"]


def test_delta_sync_reports_deleted_items_without_enqueueing_them() -> None:
    graph_client = FakeGraphClient()
    graph_client.pages[INITIAL_URL] = DeltaPage(
        items=[
            DeltaItem("item-1", "a.md", "url", is_deleted=False, last_modified=datetime.now(UTC)),
            DeltaItem("item-2", "b.md", "url", is_deleted=True, last_modified=datetime.now(UTC)),
        ],
        next_link=None,
        delta_link="token",
    )
    connector, enqueued = _connector(graph_client)

    result = connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)

    assert [item.item_id for item in result.deleted] == ["item-2"]
    assert [job.item_id for job in enqueued] == ["item-1"]


def test_webhook_accepts_notifications_with_matching_client_state() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {
        "value": [
            {"subscriptionId": "sub-1", "clientState": "correct-secret", "resource": "item-1"},
        ]
    }

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert len(result.accepted) == 1
    assert result.rejected == []
    assert len(enqueued) == 1
    assert enqueued[0].item_id == "item-1"
    assert enqueued[0].reason == "webhook"


def test_webhook_rejects_client_state_mismatch_and_does_not_enqueue() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {
        "value": [
            {"subscriptionId": "sub-1", "clientState": "wrong-secret", "resource": "item-1"},
        ]
    }

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert result.accepted == []
    assert len(result.rejected) == 1
    assert result.rejected[0].resource == "item-1"
    assert enqueued == []


def test_webhook_handles_mixed_batch_partially_accepting() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {
        "value": [
            {"subscriptionId": "sub-1", "clientState": "correct-secret", "resource": "item-1"},
            {"subscriptionId": "sub-1", "clientState": "forged", "resource": "item-2"},
            {"subscriptionId": "sub-1", "clientState": "correct-secret", "resource": "item-3"},
        ]
    }

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert [n.resource for n in result.accepted] == ["item-1", "item-3"]
    assert [n.resource for n in result.rejected] == ["item-2"]
    assert [job.item_id for job in enqueued] == ["item-1", "item-3"]


def test_webhook_rejects_missing_client_state() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {"value": [{"subscriptionId": "sub-1", "resource": "item-1"}]}  # no clientState at all

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert result.accepted == []
    assert len(result.rejected) == 1
    assert enqueued == []


def test_ensure_subscriptions_fresh_renews_expiring_subscriptions() -> None:
    graph_client = FakeGraphClient()
    connector, _ = _connector(graph_client)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    expiring_soon = GraphSubscription("sub-1", "resource-1", "secret", now + timedelta(hours=2))
    not_expiring_soon = GraphSubscription("sub-2", "resource-2", "secret", now + timedelta(days=2))
    graph_client.subscriptions = {"sub-1": expiring_soon, "sub-2": not_expiring_soon}

    refreshed = connector.ensure_subscriptions_fresh(
        [expiring_soon, not_expiring_soon], now=now, renewal_buffer=timedelta(hours=24)
    )

    assert graph_client.renewed_subscription_ids == ["sub-1"]
    refreshed_by_id = {sub.subscription_id: sub for sub in refreshed}
    assert refreshed_by_id["sub-1"].expiration_datetime > expiring_soon.expiration_datetime
    assert refreshed_by_id["sub-2"].expiration_datetime == not_expiring_soon.expiration_datetime


# --- F1: the shared secret must fail closed, not open --------------------


def test_webhook_rejects_when_expected_client_state_is_empty_even_if_it_matches() -> None:
    """The exact F1 probe: with the shared secret unresolved (env var
    unset -> expected_client_state == ""), an attacker who sends an empty
    clientState must NOT be authenticated. Before the fix,
    `"" != ""` was False, so this notification was accepted."""
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {"value": [{"subscriptionId": "attacker-sub", "clientState": "", "resource": "item-attacker"}]}

    result = connector.handle_webhook_notification(
        payload, expected_client_state="", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert result.accepted == []
    assert len(result.rejected) == 1
    assert enqueued == []


def test_webhook_rejects_when_expected_client_state_is_empty_and_notification_has_none() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {"value": [{"subscriptionId": "attacker-sub", "resource": "item-attacker"}]}

    result = connector.handle_webhook_notification(
        payload, expected_client_state="", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert result.accepted == []
    assert enqueued == []


def test_webhook_uses_constant_time_comparison(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verifies `hmac.compare_digest` (not `!=`) is actually what gates
    acceptance, by spying on the real function."""
    calls: list[tuple[bytes, bytes]] = []
    real_compare_digest = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        calls.append((a, b))
        return real_compare_digest(a, b)

    monkeypatch.setattr(sharepoint_module.hmac, "compare_digest", spy)

    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {"value": [{"subscriptionId": "sub-1", "clientState": "correct-secret", "resource": "item-1"}]}

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert len(result.accepted) == 1
    assert len(enqueued) == 1
    assert calls == [(b"correct-secret", b"correct-secret")]


# --- F2: unbounded delta-sync loop, and a malformed resource -------------


def test_delta_sync_raises_rather_than_looping_forever_on_a_self_referential_next_link() -> None:
    graph_client = FakeGraphClient()
    # A page whose next_link points at itself: without a cap, run_delta_sync
    # would call get_delta_page(url) forever.
    graph_client.pages[INITIAL_URL] = DeltaPage(
        items=[DeltaItem("item-1", "a.md", "url", False, datetime.now(UTC))],
        next_link=INITIAL_URL,
        delta_link=None,
    )
    connector, enqueued = _connector(graph_client)

    with pytest.raises(DeltaSyncOverflowError):
        connector.run_delta_sync(
            site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL, max_pages=5, max_items=1_000_000
        )

    # It must have actually stopped at the page cap, not run away.
    assert len(enqueued) <= 5


def test_delta_sync_raises_when_accumulated_items_exceed_the_cap() -> None:
    graph_client = FakeGraphClient()
    graph_client.pages[INITIAL_URL] = DeltaPage(
        items=[DeltaItem(f"item-{i}", f"{i}.md", "url", False, datetime.now(UTC)) for i in range(10)],
        next_link=INITIAL_URL,
        delta_link=None,
    )
    connector, enqueued = _connector(graph_client)

    with pytest.raises(DeltaSyncOverflowError):
        connector.run_delta_sync(
            site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL, max_pages=1_000_000, max_items=25
        )

    assert len(enqueued) <= 30  # stopped well short of looping forever


def test_delta_sync_well_under_the_caps_is_unaffected() -> None:
    graph_client = FakeGraphClient()
    graph_client.pages[INITIAL_URL] = DeltaPage(
        items=[DeltaItem("item-1", "a.md", "url", False, datetime.now(UTC))],
        next_link=None,
        delta_link="https://graph.microsoft.com/v1.0/.../delta?token=abc",
    )
    connector, enqueued = _connector(graph_client)

    result = connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)

    assert result.enqueued == 1
    assert len(enqueued) == 1


def test_delta_sync_refuses_a_next_link_pointing_off_the_graph_host() -> None:
    """A poisoned persisted delta link (or a tampered next_link) pointing
    at a non-Graph host must never be requested -- `get_delta_page` would
    otherwise send the ingestion identity's bearer token to that host."""
    graph_client = FakeGraphClient()
    evil_url = "https://evil.example.com/steal-the-token"
    graph_client.pages[INITIAL_URL] = DeltaPage(items=[], next_link=evil_url, delta_link=None)
    connector, _ = _connector(graph_client)

    with pytest.raises(SuspiciousGraphUrlError):
        connector.run_delta_sync(site_id=SITE_ID, drive_id=DRIVE_ID, initial_delta_url=INITIAL_URL)


def test_webhook_rejects_a_resource_containing_a_path_traversal_sequence() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {
        "value": [
            {
                "subscriptionId": "sub-1",
                "clientState": "correct-secret",
                "resource": "../../../../subscriptions",
            }
        ]
    }

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert result.accepted == []
    assert len(result.rejected) == 1
    assert enqueued == []


def test_webhook_rejects_a_resource_containing_a_slash() -> None:
    graph_client = FakeGraphClient()
    connector, enqueued = _connector(graph_client)
    payload = {
        "value": [{"subscriptionId": "sub-1", "clientState": "correct-secret", "resource": "drives/other/items/x"}]
    }

    result = connector.handle_webhook_notification(
        payload, expected_client_state="correct-secret", site_id=SITE_ID, drive_id=DRIVE_ID
    )

    assert result.accepted == []
    assert enqueued == []
