# agentboard root Makefile.
#
# Local verification via `make check`, a pre-push hook that runs its fast
# subset, and a pinned dev toolchain container for parity across machines
# (see CONTRIBUTING.md).

SHELL := /bin/sh

.PHONY: install build typecheck lint test check ascii validate-specs hooks check-in-docker check-floor dev-shell

check: build typecheck lint test ascii validate-specs
	@echo "make check: build, typecheck, lint, test, ascii and validate-specs all passed"

# Runs `make check` inside the pinned dev toolchain container (see
# Dockerfile.dev / docker-compose.yml) instead of whatever Node happens
# to be installed on the host. node_modules is a container volume (so
# host and container binaries never mix), so it is installed first.
# Afterwards the compose project's network and volumes are removed, so
# that each worktree does not leave a Docker network behind (enough of
# them exhaust Docker's address pools); the exit status is make check's.
check-in-docker:
	docker compose run --rm --build dev sh -c 'make install && make check'; \
	status=$$?; docker compose down --volumes --remove-orphans >/dev/null 2>&1; exit $$status

# Runs `make check` on the oldest supported Node (the engines floor in
# package.json), which check-in-docker does not, because its image tracks
# the latest Node 22.
check-floor:
	docker compose run --rm --build dev-floor sh -c 'make install && make check'; \
	status=$$?; docker compose down --volumes --remove-orphans >/dev/null 2>&1; exit $$status

# Points git at the repo-tracked hooks directory so pre-push runs the
# fast local checks before every push. Run once per clone/worktree.
hooks:
	git config core.hooksPath .githooks

# Opens an interactive shell in the pinned dev toolchain container, with
# the repo bind-mounted at /workspace.
dev-shell:
	docker compose run --rm dev bash

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm run test

# Fails on non-ASCII bytes in docs/specs/READMEs and src. Uses a POSIX
# bracket byte range ([\200-\377], i.e. bytes >= 0x80) built with printf
# instead of `grep -P`: BSD grep on macOS has no -P, and this form
# matches under both BSD and GNU grep, on the host and in the dev
# container. LC_ALL=C keeps grep operating on raw bytes so it does not
# choke on invalid/partial UTF-8 sequences.
ascii:
	@pattern=$$(printf '[\200-\377]'); \
	if LC_ALL=C grep -RIl "$$pattern" docs openspec README.md CLAUDE.md CONTRIBUTING.md src; then \
		echo "non-ASCII byte(s) found in the file(s) listed above" >&2; \
		exit 1; \
	fi; \
	echo "No non-ASCII bytes found."

validate-specs:
	npx --yes @fission-ai/openspec@latest validate --all --no-interactive
