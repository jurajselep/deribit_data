# optstore

This repository hosts an experimental options tick storage engine. The current implementation focuses on a minimal vertical slice:

- Retrieve Deribit public trade data for a symbol/day into a compressed raw cache.
- Surface progress and JSON events throughout the retrieve/ingest flow.
- Provide a placeholder ingest path that writes binary tick stubs while reporting throughput.

Further work will extend the format, block codecs, query engine, and WAL mechanics.
