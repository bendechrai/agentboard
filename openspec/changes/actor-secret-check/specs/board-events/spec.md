## ADDED Requirements

### Requirement: Event actors have no form
The actor form and the secret patterns of board-cli "Actor names are
checked" SHALL be rules for writing only. An event SHALL NOT be
malformed because its `actor`, its `ts.actor` or an actor name in its
payload (such as the `to` of `ticket.handoff`) fails that check: it SHALL
be validated, folded, cached and synced exactly as an event whose actor
passes, so that events already on a board, and events written by an
older version to a shared board, fold the same in every clone. The
envelope rules of an actor (non-empty; `ts.actor` equal to `actor`; the
reserved system actor) are unchanged.

#### Scenario: Event with a token as its actor
- **WHEN** the event log holds a `ticket.comment` whose `actor` and `ts.actor` are a 40-character token
- **THEN** it is not reported as malformed, the comment is folded and attributed to that actor, and `rebuild --check` reports no divergence

#### Scenario: Hand-off to a name outside the form
- **WHEN** the event log holds a `ticket.handoff` whose `to` is `Ben Dechrai`
- **THEN** it is folded and the ticket is assigned to `Ben Dechrai`
