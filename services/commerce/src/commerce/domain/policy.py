"""Who may do what (business book §12) and how a change moves (§7.1).

This is the one role matrix of the platform: the gateway repeats it before
calling, the engine decides with it, and the database holds the parts it can
on its own (migration V2: the signer is not the author and holds the role
they sign with). Roles are the book's names, the ones the database uses.
"""

from __future__ import annotations

ROLES = ("marketing", "commercial_lead", "finance", "catalog_manager", "on_call", "auditor")
SIGNING_ROLES = frozenset({"commercial_lead", "finance"})

# The kinds of change the contract carries content for today; the database
# already knows the three that stage 7 adds.
KINDS = ("offer", "list_price")

# Who writes each kind: CreateChange, SaveVersion, ValidateChange, SubmitChange.
AUTHORS: dict[str, frozenset[str]] = {
    "offer": frozenset({"marketing"}),
    "list_price": frozenset({"commercial_lead"}),
}
# Finance approves but does not set a launch going: separation of duties.
SCHEDULERS: dict[str, frozenset[str]] = {
    "offer": frozenset({"marketing", "commercial_lead"}),
    "list_price": frozenset({"commercial_lead"}),
}
# Cancelling a scheduled launch is part of "roll back a launch" (§12).
CANCELLERS: dict[str, frozenset[str]] = {
    "offer": frozenset({"marketing", "commercial_lead", "on_call"}),
    "list_price": frozenset({"commercial_lead", "on_call"}),
}
SUSPENDERS = frozenset({"on_call"})
# Retrying or cancelling a launch that stopped: "roll back a launch" (§12).
LAUNCH_OPERATORS = frozenset({"on_call"})
SIMULATORS = frozenset({"marketing", "commercial_lead", "finance"})
CHAIN_VERIFIERS = frozenset({"auditor", "on_call"})
HEAD_EXPORTERS = frozenset({"auditor"})
# Revenue and the artists' top-ups on the home page (§12: finance reads revenue).
REVENUE_READERS = frozenset({"finance", "commercial_lead"})

# §7.1, the same moves the database trigger allows (migration V2).
TRANSITIONS: dict[str, tuple[str, ...]] = {
    "draft": ("validated",),
    "validated": ("in_approval",),
    "in_approval": ("approved", "draft"),
    "approved": ("scheduled",),
    "scheduled": ("active", "cancelled"),
    "active": ("ended", "suspended"),
}
# A new version is possible until the change is scheduled, and it always
# returns the change to draft: approvals never carry over (§7.2).
TAKES_NEW_VERSIONS = ("draft", "validated", "in_approval", "approved")

ROLE_NAMES = {
    "marketing": "marketing", "commercial_lead": "the commercial lead", "finance": "finance",
    "catalog_manager": "the catalog manager", "on_call": "the on-call engineer", "auditor": "the auditor",
}
KIND_NAMES = {"offer": "an offer", "list_price": "a list price", "entitlement": "a plan's entitlements",
              "price_migration": "a price migration", "prepaid": "a prepaid pass"}


def can_move(state: str, to: str) -> bool:
    return to in TRANSITIONS.get(state, ())


def who(roles: frozenset[str]) -> str:
    names = [ROLE_NAMES[r] for r in ROLES if r in roles]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " or " + names[-1]
