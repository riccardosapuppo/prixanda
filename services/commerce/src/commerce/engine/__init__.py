"""The engine's services: catalog, quotes, changes and approvals,
simulation, audit, overview and people, over the contract in proto/.

They speak the contract's messages (protobuf, which runs in the browser too)
and reach PostgreSQL only through commerce.engine.database, a small
interface: an asyncpg adapter serves the full system today, and a bridge to
PGlite will serve the browser sandbox at stage 8. Nothing in this package
imports grpc or asyncpg, and nothing reads the machine's clock: time comes
from the Clock the engine is built with.

The gRPC server (commerce.server) is a thin layer on top: it checks the
internal token, reads the call's metadata, and maps the engine's errors to
status codes.
"""
