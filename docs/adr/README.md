# Architecture decision records

This directory records the significant decisions made about agentboard's
design, in MADR format. Index:

- [0001. Event log as the source of truth](0001-event-log-source-of-truth.md)
- [0002. One transaction per command, event file inside it](0002-one-transaction-per-command.md)
- [0003. Inbox cursors as a position plus a seen set](0003-cursors-as-position-plus-seen-set.md)
- [0004. Source-neutral task reference](0004-source-neutral-task-reference.md)
- [0005. Sync commits only its own paths, as a fixed identity](0005-sync-commits-only-its-own-paths.md)
