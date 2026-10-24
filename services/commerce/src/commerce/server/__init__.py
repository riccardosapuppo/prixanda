"""The engine behind gRPC: a thin layer over commerce.engine.

    python -m commerce.server        (or npm run engine, which also starts the
                                      development database and passes the token)

It checks the internal token the gateway sends, reads the call's metadata,
hands the call to the engine and maps the engine's errors to status codes. It
also serves the standard health protocol, runs the minimal activation on a
timer until stage 6 brings the job runner, and stops in order: no new calls,
the running ones finish, then the database pool closes.

Identities. The gateway authenticates to the engine with the internal token
and says in each call who acts. The engine checks that this person exists and
holds that role; it does not authenticate people. The gateway's sessions are
a demonstration mode, in which a visitor picks one of the demo's people: that
is not authentication, and a real deployment would put an identity provider
(OIDC) in front of the gateway. Nothing the browser sends can grant a role.
"""
