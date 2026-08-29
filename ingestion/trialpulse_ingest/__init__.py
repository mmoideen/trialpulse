"""TrialPulse ingestion pipeline.

This package implements the ingestion workstream described in the TrialPulse
PRD (sections 2.3 decision 2, 3.3.1, 4.2, 4.3, and 8): a headings-aware,
idempotent, version-aware document ingestion pipeline that turns SharePoint
documents (and, for local development, a synthetic markdown corpus) into
`Chunk` records in Azure AI Search.

Every module here is designed to run fully offline: real Azure SDKs
(azure-identity, azure-search-documents, openai, python-docx, pypdf) are
imported lazily inside the functions/classes that need them, so importing
this package -- and running its test suite -- never requires network access
or those optional dependencies to be installed.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
