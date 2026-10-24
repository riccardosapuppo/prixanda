"""The commerce engine behind Box Office.

It decides what Encore sells, at what price, from when and with whose
signature, and keeps the record of every decision. Its rules live in two
places on purpose: here, and again in PostgreSQL, so that a bug in one layer
does not open the door (business book §7.4).
"""
