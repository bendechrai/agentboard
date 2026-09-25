# Architecture decision records

This directory records the significant decisions made about agentboard's
design, in MADR format. Index:

- [0001. Event log as the source of truth](0001-event-log-source-of-truth.md)
- [0002. One transaction per command, event file inside it](0002-one-transaction-per-command.md)
- [0003. Inbox cursors as a position plus a seen set](0003-cursors-as-position-plus-seen-set.md)
- [0004. Source-neutral task reference](0004-source-neutral-task-reference.md)
- [0005. Sync commits only its own paths, as a fixed identity](0005-sync-commits-only-its-own-paths.md)
- [0006. Local web server security model](0006-local-web-server-security-model.md)
- [0007. Board feed with append, resync and digest resume; a shared view-model](0007-board-feed-and-shared-view-model.md)
- [0008. Terminal UI without a library](0008-terminal-ui-without-a-library.md)
- [0009. Write actions in the web app](0009-web-write-actions-security.md)
