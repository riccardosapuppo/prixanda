"""The engine in the browser (stage 8): the same rules, in Pyodide, on PGlite.

The demo runs this package, the domain and the engine's services in a
browser's worker, behind the same protobuf contract as the gRPC server: the
gateway's core calls it through a transport of its own, as it calls the
server over gRPC on Node. Nothing here imports grpc or asyncpg, and nothing
of the server's process (commerce.server) is in the browser's package.

  pglite.py    the engine's Database on PGlite, through the page's bridge
  sandbox.py   the entrance the page calls: a call of the contract, the jobs,
               the demo's clock and its simulated fault
  snapshot.py  the build's small data, written into PGlite by the same
               generator as the server's (only the build runs it)
"""
