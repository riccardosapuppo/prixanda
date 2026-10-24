"""The rules of the business book as plain Python.

Nothing in this package reads a clock, opens a connection or imports grpc or
asyncpg: it is handed numbers, texts and instants, and returns answers. The
same modules run in the server and, from stage 8, in the browser sandbox
(Pyodide), so they stay within the standard library.
"""
