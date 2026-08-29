"""SharePoint / Microsoft Graph connector: webhook handling, subscription
management, and the daily delta-sync catch-up.

PRD 5.3 + workflow 3.3.1 + risk 11.3: SharePoint webhooks can miss events or
arrive out of order, so a daily delta sync against Graph's
`/sites/{id}/drives/{id}/root/delta` endpoint is the safety net. Both paths
funnel through `enqueue` (an injectable callable) rather than ingesting
documents inline, so a webhook flood cannot overwhelm the pipeline (PRD
"Optimization Recommendations": "Queue-based ingestion prevents SharePoint
webhook floods from overwhelming the system").

The real Graph HTTP client (`GraphSharePointClient`) is behind the
`GraphClient` protocol so every test in this module runs against
`FakeGraphClient` with no network access.
"""

from __future__ import annotations

import hmac
import re
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Protocol

from trialpulse_ingest.constants import (
    MAX_DELTA_SYNC_ITEMS,
    MAX_DELTA_SYNC_PAGES,
    SUBSCRIPTION_MAX_LIFETIME_DAYS,
    SUBSCRIPTION_RENEWAL_BUFFER_HOURS,
)
from trialpulse_ingest.retry import PermanentError

if TYPE_CHECKING:
    from trialpulse_ingest.models import DocumentMetadata

#: Microsoft Graph's host. `get_delta_page`'s `url` argument is an ABSOLUTE
#: URL taken from `@odata.nextLink`/`@odata.deltaLink` or a persisted
#: `DeltaLinkStore` entry -- none of which this connector should trust
#: blindly, because `GraphSharePointClient` authenticates with a bearer
#: token and httpx sends client-level (and, after the F2 fix, per-request)
#: headers to *any* absolute URL regardless of the client's `base_url`. See
#: `_assert_graph_host`.
_GRAPH_HOST = "graph.microsoft.com"

#: Real Microsoft Graph drive/item ids are opaque, URL-safe, base64url-ish
#: tokens (alphanumeric plus a handful of punctuation characters). This is
#: deliberately permissive enough to accept real ids while excluding every
#: character that could change the *shape* of a URL an id is interpolated
#: into (no `/`, `?`, `#`, whitespace, or NUL).
_GRAPH_ITEM_ID_RE = re.compile(r"^[A-Za-z0-9!_.-]+$")


class ClientStateMismatchError(Exception):
    """A webhook notification's clientState did not match what we registered.

    Per PRD 5.3 ("Signature validation uses the SharePoint webhook
    validation token") and Microsoft's guidance, clientState is the
    shared secret proving a notification actually came from the
    subscription we created -- anyone can POST to a public webhook URL, so
    a mismatch must never be enqueued for ingestion.
    """


class DeltaSyncOverflowError(Exception):
    """`run_delta_sync` exceeded its page or item safety cap (F2: an
    unbounded `while True` loop over `next_link` pages, terminated only by
    a `delta_link` or a missing `next_link`, would otherwise loop forever
    against a response -- or a poisoned persisted delta link -- that always
    returns a `next_link`). Raised rather than silently truncated: a
    silent truncation would leave the delta link unpersisted mid-stream
    with no signal to the caller that the sync was incomplete.
    """


class SuspiciousGraphUrlError(Exception):
    """A URL that was about to be sent to Microsoft Graph -- carrying the
    ingestion identity's bearer token -- does not point at Graph's own
    host. See `_assert_graph_host`.
    """


class InvalidGraphIdError(Exception):
    """A Graph drive/item id failed charset validation before being
    interpolated into a request path (F2: an unvalidated id sourced from
    an attacker-supplied webhook `resource` could otherwise escape the
    intended `/drives/{id}/items/{id}/content` endpoint via `..` or `/`,
    which httpx's URL normalisation then collapses onto an arbitrary Graph
    endpoint under the ingestion identity).
    """


class DocumentMetadataResolutionError(PermanentError):
    """A queued `IngestionJob` could not be resolved into `DocumentMetadata`.

    Always a `PermanentError` (never retried): a missing or misnamed
    SharePoint list column does not become less missing on a retry, and
    dead-lettering immediately gets a human looking at the real problem
    instead of burning three retries first. See `GraphItemMetadataResolver`.
    """


def _is_valid_graph_item_id(value: str) -> bool:
    return bool(value) and "/" not in value and ".." not in value and bool(_GRAPH_ITEM_ID_RE.fullmatch(value))


def validate_graph_item_id(value: str, *, field_name: str) -> str:
    """Validate a Graph drive/item id against the charset Graph actually
    uses, raising `InvalidGraphIdError` for anything else. Call this
    immediately before interpolating a drive/item id into a request path.
    """
    if not _is_valid_graph_item_id(value):
        raise InvalidGraphIdError(f"{field_name} {value!r} is not a valid Graph drive/item id.")
    return value


def _client_state_matches(actual: str | None, expected: str) -> bool:
    """Timing-safe `clientState` comparison that fails closed.

    `expected` falsy (an unset/empty shared secret) is rejected
    unconditionally, *before* any comparison -- an empty expected value
    must never authenticate an empty (or any) actual value. When
    `expected` is non-empty, the comparison uses `hmac.compare_digest`
    (not `!=`) so a mismatch takes the same amount of time regardless of
    how many leading bytes happen to match, exactly like the TypeScript
    orchestrator's equivalent check.
    """
    if not expected:
        return False
    return hmac.compare_digest((actual or "").encode("utf-8"), expected.encode("utf-8"))


def _assert_graph_host(url: str) -> None:
    """Refuse to build a request against an absolute URL that does not
    point at Microsoft Graph. Relative paths (no scheme/netloc) are always
    safe -- they resolve against the client's fixed Graph `base_url`.
    """
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme and parsed.netloc.lower() != _GRAPH_HOST:
        raise SuspiciousGraphUrlError(
            f"Refusing to send a Graph API request to {url!r}: host {parsed.netloc!r} is not "
            f"{_GRAPH_HOST!r}. This URL came from an @odata.nextLink/@odata.deltaLink or a "
            "persisted delta link, either of which could be tampered with, and it would "
            "otherwise be sent the ingestion identity's bearer token."
        )


@dataclass(frozen=True, slots=True)
class DeltaItem:
    """One changed (or deleted) item from a Graph delta page."""

    item_id: str
    name: str
    web_url: str
    is_deleted: bool
    last_modified: datetime


@dataclass(frozen=True, slots=True)
class DeltaPage:
    items: list[DeltaItem]
    next_link: str | None
    """Present when more pages remain; call get_delta_page(next_link) again."""
    delta_link: str | None
    """Present on the final page; persist it and use it as the starting
    point for the *next* sync so only items changed since are returned."""


@dataclass(frozen=True, slots=True)
class GraphSubscription:
    subscription_id: str
    resource: str
    client_state: str
    expiration_datetime: datetime


class GraphClient(Protocol):
    """Everything the connector needs from Microsoft Graph."""

    def get_delta_page(self, url: str) -> DeltaPage: ...

    def download_item_content(self, drive_id: str, item_id: str) -> bytes: ...

    def get_item_metadata(self, *, drive_id: str, item_id: str) -> dict: ...

    def create_subscription(
        self, *, resource: str, notification_url: str, client_state: str, expiration: datetime
    ) -> GraphSubscription: ...

    def renew_subscription(self, subscription_id: str, *, expiration: datetime) -> GraphSubscription: ...


class DeltaLinkStore(Protocol):
    """Persists the Graph delta link between sync runs, keyed by drive id."""

    def get(self, drive_id: str) -> str | None: ...

    def set(self, drive_id: str, delta_link: str) -> None: ...


class InMemoryDeltaLinkStore:
    """Fake `DeltaLinkStore` for tests and local development."""

    def __init__(self) -> None:
        self._links: dict[str, str] = {}

    def get(self, drive_id: str) -> str | None:
        return self._links.get(drive_id)

    def set(self, drive_id: str, delta_link: str) -> None:
        self._links[drive_id] = delta_link


@dataclass(frozen=True, slots=True)
class IngestionJob:
    """The message enqueued onto the ingestion queue by both the webhook
    handler and the delta sync. `function_app.py`'s queue trigger consumes
    exactly this shape."""

    site_id: str
    drive_id: str
    item_id: str
    reason: str
    """"webhook" or "delta_sync" -- useful for audit/telemetry, not for logic."""


@dataclass(frozen=True, slots=True)
class SyncResult:
    changed: list[DeltaItem]
    deleted: list[DeltaItem]
    enqueued: int


@dataclass(frozen=True, slots=True)
class WebhookNotification:
    subscription_id: str
    client_state: str | None
    resource: str


@dataclass(frozen=True, slots=True)
class WebhookResult:
    accepted: list[WebhookNotification] = field(default_factory=list)
    rejected: list[WebhookNotification] = field(default_factory=list)


class SharePointConnector:
    """Orchestrates delta sync and webhook handling. All Graph I/O goes
    through the injected `GraphClient`; all queueing goes through the
    injected `enqueue` callable, so this class has no I/O of its own and is
    fully unit-testable."""

    def __init__(
        self,
        graph_client: GraphClient,
        delta_link_store: DeltaLinkStore,
        enqueue: Callable[[IngestionJob], None],
    ) -> None:
        self._graph_client = graph_client
        self._delta_link_store = delta_link_store
        self._enqueue = enqueue

    def run_delta_sync(
        self,
        *,
        site_id: str,
        drive_id: str,
        initial_delta_url: str,
        max_pages: int = MAX_DELTA_SYNC_PAGES,
        max_items: int = MAX_DELTA_SYNC_ITEMS,
    ) -> SyncResult:
        """The daily scheduled catch-up sync (PRD 3.3.1, risk 11.3).

        Follows `next_link` pages until Graph returns a `delta_link`, then
        persists that link so the next run only sees items changed since
        this one. Every non-deleted item is enqueued for re-ingestion;
        deleted items are reported but not enqueued for ingestion (deletion
        handling -- e.g. tombstoning -- is out of scope for this connector
        and is a product decision left to the orchestrator/pipeline layer).

        Bounded by `max_pages`/`max_items` (F2): a response -- or a
        poisoned persisted delta link -- that always returns a `next_link`
        and never a `delta_link` would otherwise loop forever, growing
        `changed`/`deleted` without bound and enqueueing on every item.
        Raises `DeltaSyncOverflowError` rather than truncating silently, so
        an operator sees a clear failure instead of a sync that quietly
        stopped partway through with the delta link never persisted.
        """
        stored_link = self._delta_link_store.get(drive_id)
        url = stored_link or initial_delta_url

        changed: list[DeltaItem] = []
        deleted: list[DeltaItem] = []
        enqueued = 0
        pages_fetched = 0

        while True:
            pages_fetched += 1
            if pages_fetched > max_pages:
                raise DeltaSyncOverflowError(
                    f"Delta sync for drive {drive_id!r} exceeded {max_pages} pages without "
                    "reaching a delta_link; aborting rather than looping forever. This usually "
                    "means a poisoned or self-referential next_link -- inspect the persisted "
                    "delta link before retrying."
                )

            _assert_graph_host(url)
            page = self._graph_client.get_delta_page(url)
            for item in page.items:
                if len(changed) + len(deleted) >= max_items:
                    raise DeltaSyncOverflowError(
                        f"Delta sync for drive {drive_id!r} exceeded {max_items} accumulated "
                        "changed+deleted items without reaching a delta_link; aborting rather "
                        "than growing without bound."
                    )
                if item.is_deleted:
                    deleted.append(item)
                    continue
                changed.append(item)
                self._enqueue(
                    IngestionJob(site_id=site_id, drive_id=drive_id, item_id=item.item_id, reason="delta_sync")
                )
                enqueued += 1

            if page.delta_link:
                self._delta_link_store.set(drive_id, page.delta_link)
                break
            if not page.next_link:
                # Defensive: a well-formed Graph response always has either
                # next_link or delta_link on every page.
                break
            url = page.next_link

        return SyncResult(changed=changed, deleted=deleted, enqueued=enqueued)

    def handle_webhook_notification(
        self, payload: dict, *, expected_client_state: str, site_id: str, drive_id: str
    ) -> WebhookResult:
        """Handle a SharePoint change notification payload (PRD 5.3).

        A single payload can bundle several notifications; each is checked
        independently against `expected_client_state` so one forged/stale
        notification cannot block legitimate ones in the same batch.
        Accepted notifications enqueue a re-ingestion job keyed by the
        notification's `resource` (used as the drive item id).

        Two independent checks gate acceptance, both fixes for F1/F2:

        1. `expected_client_state` is rejected unconditionally when falsy
           (empty string), and the comparison against the notification's
           `clientState` uses `hmac.compare_digest` rather than `!=`. An
           empty *expected* value must never authenticate an empty (or any)
           *actual* value -- if the shared secret failed to resolve (an
           unset env var, a Key Vault reference that failed to resolve, an
           RBAC propagation delay), this endpoint must authenticate
           nobody, not everybody.
        2. The notification's `resource` -- which becomes the queued job's
           `item_id` and, downstream, is interpolated into a Graph request
           path in `GraphSharePointClient.download_item_content` -- is
           validated against the Graph drive-item id charset right here,
           at the point the (attacker-supplied) notification is turned
           into a `WebhookNotification`. A malformed `resource` is
           rejected rather than ever reaching the queue.
        """
        result = WebhookResult()
        for raw in payload.get("value", []):
            notification = WebhookNotification(
                subscription_id=raw.get("subscriptionId", ""),
                client_state=raw.get("clientState"),
                resource=raw.get("resource", ""),
            )
            if not _client_state_matches(notification.client_state, expected_client_state):
                result.rejected.append(notification)
                continue
            if not _is_valid_graph_item_id(notification.resource):
                result.rejected.append(notification)
                continue
            result.accepted.append(notification)
            self._enqueue(
                IngestionJob(
                    site_id=site_id,
                    drive_id=drive_id,
                    item_id=notification.resource,
                    reason="webhook",
                )
            )
        return result

    def ensure_subscriptions_fresh(
        self,
        subscriptions: list[GraphSubscription],
        *,
        now: datetime,
        renewal_buffer: timedelta = timedelta(hours=SUBSCRIPTION_RENEWAL_BUFFER_HOURS),
        new_lifetime: timedelta = timedelta(days=SUBSCRIPTION_MAX_LIFETIME_DAYS),
    ) -> list[GraphSubscription]:
        """Renew any subscription expiring within `renewal_buffer` of `now`.

        Graph subscriptions on drive resources have a short maximum
        lifetime (days, not months), so this must run frequently enough
        (the timer trigger in `function_app.py` runs it daily alongside the
        delta sync) that a subscription never lapses and silently stops
        delivering webhooks.
        """
        refreshed: list[GraphSubscription] = []
        for subscription in subscriptions:
            if subscription.expiration_datetime - now <= renewal_buffer:
                refreshed.append(
                    self._graph_client.renew_subscription(
                        subscription.subscription_id, expiration=now + new_lifetime
                    )
                )
            else:
                refreshed.append(subscription)
        return refreshed


class GraphSharePointClient:
    """Real Microsoft Graph client.

    Authenticates via `azure.identity` managed identity (PRD 8.1: no
    secrets in code) and speaks Graph's REST API over `httpx`. Both imports
    are deferred so this class can exist in the module without either
    package being importable unless it is actually instantiated.
    """

    _GRAPH_BASE = "https://graph.microsoft.com/v1.0"

    def __init__(self, *, credential: object | None = None, http_client: object | None = None) -> None:
        self._credential = credential
        self._http_client = http_client

    def _get_http_client(self):  # noqa: ANN202 -- lazily-imported httpx.Client
        if self._http_client is not None:
            return self._http_client
        import httpx  # noqa: PLC0415

        # No `Authorization` header here (F2): a client-level header is sent
        # by httpx on EVERY request made through this client, including
        # requests to an absolute URL outside `base_url` -- and
        # `get_delta_page`'s `url` argument is exactly such an absolute URL,
        # sourced from `@odata.nextLink`/`@odata.deltaLink` or a persisted
        # `DeltaLinkStore` entry. A poisoned link would otherwise exfiltrate
        # the ingestion managed identity's Graph bearer token to whatever
        # host it points at. See `_auth_headers`, applied per request
        # instead, and `_assert_graph_host`, which additionally refuses any
        # absolute URL that isn't Graph's own host.
        self._http_client = httpx.Client(base_url=self._GRAPH_BASE, timeout=30.0)
        return self._http_client

    def _auth_headers(self) -> dict[str, str]:
        """A fresh `Authorization` header, fetched per request rather than
        cached on the client (see `_get_http_client`). `credential.get_token`
        is itself cached/refreshed internally by `azure-identity`, so this
        is not an extra round trip on every call -- it is the difference
        between a header that can silently outlive its token's expiry and
        one that can't.
        """
        credential = self._credential
        if credential is None:
            from azure.identity import DefaultAzureCredential  # noqa: PLC0415

            credential = DefaultAzureCredential()
            self._credential = credential
        token = credential.get_token("https://graph.microsoft.com/.default").token
        return {"Authorization": f"Bearer {token}"}

    def get_delta_page(self, url: str) -> DeltaPage:
        _assert_graph_host(url)
        client = self._get_http_client()
        response = client.get(url, headers=self._auth_headers())
        response.raise_for_status()
        body = response.json()
        items = [
            DeltaItem(
                item_id=entry["id"],
                name=entry.get("name", ""),
                web_url=entry.get("webUrl", ""),
                is_deleted="deleted" in entry,
                last_modified=datetime.fromisoformat(
                    entry.get("lastModifiedDateTime", "1970-01-01T00:00:00Z").replace("Z", "+00:00")
                ),
            )
            for entry in body.get("value", [])
        ]
        return DeltaPage(
            items=items,
            next_link=body.get("@odata.nextLink"),
            delta_link=body.get("@odata.deltaLink"),
        )

    def download_item_content(self, drive_id: str, item_id: str) -> bytes:
        # F2: `item_id` traces back to an attacker-supplied webhook
        # `resource`, gated only by clientState. httpx/URL normalisation
        # resolves `..` segments, so an unvalidated id could otherwise
        # reach an arbitrary Graph endpoint under the ingestion identity
        # (e.g. `../../subscriptions`). `handle_webhook_notification`
        # already rejects invalid ids before they reach the queue; this is
        # the defense-in-depth check at the actual point of interpolation.
        validate_graph_item_id(drive_id, field_name="drive_id")
        validate_graph_item_id(item_id, field_name="item_id")
        client = self._get_http_client()
        response = client.get(f"/drives/{drive_id}/items/{item_id}/content", headers=self._auth_headers())
        response.raise_for_status()
        return response.content

    def get_item_metadata(self, *, drive_id: str, item_id: str) -> dict:
        """The drive item plus its SharePoint list item fields, for
        resolving `DocumentMetadata` (classification, version, supersedes,
        effective_date, site_code) out of the list's metadata columns --
        see `GraphItemMetadataResolver`.
        """
        validate_graph_item_id(drive_id, field_name="drive_id")
        validate_graph_item_id(item_id, field_name="item_id")
        client = self._get_http_client()
        response = client.get(
            f"/drives/{drive_id}/items/{item_id}?$expand=listItem($expand=fields)",
            headers=self._auth_headers(),
        )
        response.raise_for_status()
        return response.json()

    def create_subscription(
        self, *, resource: str, notification_url: str, client_state: str, expiration: datetime
    ) -> GraphSubscription:
        client = self._get_http_client()
        response = client.post(
            "/subscriptions",
            json={
                "changeType": "updated,deleted",
                "notificationUrl": notification_url,
                "resource": resource,
                "expirationDateTime": expiration.isoformat(),
                "clientState": client_state,
            },
            headers=self._auth_headers(),
        )
        response.raise_for_status()
        body = response.json()
        return GraphSubscription(
            subscription_id=body["id"],
            resource=resource,
            client_state=client_state,
            expiration_datetime=expiration,
        )

    def renew_subscription(self, subscription_id: str, *, expiration: datetime) -> GraphSubscription:
        client = self._get_http_client()
        response = client.patch(
            f"/subscriptions/{subscription_id}",
            json={"expirationDateTime": expiration.isoformat()},
            headers=self._auth_headers(),
        )
        response.raise_for_status()
        body = response.json()
        return GraphSubscription(
            subscription_id=body["id"],
            resource=body.get("resource", ""),
            client_state=body.get("clientState", ""),
            expiration_datetime=expiration,
        )


class FakeGraphClient:
    """In-memory `GraphClient` fake used by every test in this module."""

    def __init__(self) -> None:
        self.pages: dict[str, DeltaPage] = {}
        self.downloads: dict[str, bytes] = {}
        self.item_metadata: dict[str, dict] = {}
        self.subscriptions: dict[str, GraphSubscription] = {}
        self.renewed_subscription_ids: list[str] = []

    def get_delta_page(self, url: str) -> DeltaPage:
        try:
            return self.pages[url]
        except KeyError as exc:
            raise AssertionError(f"FakeGraphClient has no page registered for url {url!r}") from exc

    def download_item_content(self, drive_id: str, item_id: str) -> bytes:
        validate_graph_item_id(drive_id, field_name="drive_id")
        validate_graph_item_id(item_id, field_name="item_id")
        return self.downloads[f"{drive_id}/{item_id}"]

    def get_item_metadata(self, *, drive_id: str, item_id: str) -> dict:
        validate_graph_item_id(drive_id, field_name="drive_id")
        validate_graph_item_id(item_id, field_name="item_id")
        return self.item_metadata[f"{drive_id}/{item_id}"]

    def create_subscription(
        self, *, resource: str, notification_url: str, client_state: str, expiration: datetime
    ) -> GraphSubscription:
        subscription = GraphSubscription(
            subscription_id=f"sub-{len(self.subscriptions) + 1}",
            resource=resource,
            client_state=client_state,
            expiration_datetime=expiration,
        )
        self.subscriptions[subscription.subscription_id] = subscription
        return subscription

    def renew_subscription(self, subscription_id: str, *, expiration: datetime) -> GraphSubscription:
        self.renewed_subscription_ids.append(subscription_id)
        existing = self.subscriptions[subscription_id]
        renewed = replace_expiration(existing, expiration)
        self.subscriptions[subscription_id] = renewed
        return renewed


def replace_expiration(subscription: GraphSubscription, expiration: datetime) -> GraphSubscription:
    return GraphSubscription(
        subscription_id=subscription.subscription_id,
        resource=subscription.resource,
        client_state=subscription.client_state,
        expiration_datetime=expiration,
    )


class GraphItemMetadataResolver(Protocol):
    """Resolves one queued `IngestionJob` into `DocumentMetadata`.

    PRODUCTION WIRING GAP (see ingestion/README.md, "Remaining production
    wiring"): the real implementation must read the classification,
    version, supersedes, effective_date, and site_code columns off the
    SharePoint list item behind the drive item named by the job (via
    `GraphClient.get_item_metadata`). This repository does not know the
    real TrialPulse SharePoint document library's column schema (the
    internal names, which are frequently NOT the same as the display names
    shown in the library UI), so no default implementation can safely
    guess at it. `function_app.py` calls this resolver via an injected
    callable so that once the schema is confirmed, only one function needs
    to change and no test in this suite needs to.
    """

    def __call__(self, job: IngestionJob) -> DocumentMetadata: ...


def unconfigured_metadata_resolver(job: IngestionJob) -> DocumentMetadata:
    """Default `GraphItemMetadataResolver`: fails loudly and specifically.

    See `GraphItemMetadataResolver`'s docstring for why there is no
    default mapping to fall back to. Raising `DocumentMetadataResolutionError`
    (a `PermanentError`) rather than guessing at SharePoint column names
    matters: a wrong guess could silently misclassify a clinical document
    (the wrong `document_classification` routes it past the wrong RBAC
    redaction rule in the orchestrator), which is a worse failure mode
    than a dead-lettered queue message a human has to look at.
    """
    raise DocumentMetadataResolutionError(
        f"No SharePoint list item metadata resolver is configured; cannot resolve "
        f"DocumentMetadata for drive_id={job.drive_id!r} item_id={job.item_id!r}. "
        "See ingestion/README.md, 'Remaining production wiring': the real TrialPulse "
        "SharePoint document library's column schema must be confirmed against the tenant "
        "and wired in (function_app.get_metadata_resolver) before this queue can process "
        "real jobs."
    )
