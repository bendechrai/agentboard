# agentboard root Makefile.
#
# Local verification via `make check`, a pre-push hook that runs its fast
# subset, and a pinned dev toolchain container for parity across machines
# (see CONTRIBUTING.md).

SHELL := /bin/sh

.PHONY: install build typecheck lint test check ascii validate-specs hooks check-in-docker check-floor check-git-floor test-sharing dev-shell

# The oldest git the host model supports (HOST_MODEL_GIT_FLOOR in
# src/board/git.ts), as <major>.<minor>. check-git-floor refuses to run the
# tests on any other release line, and src/__tests__/git-floor.test.ts
# checks that this value, the constant and the dev-git-floor image agree.
GIT_FLOOR := 2.32

# The test files that exercise board sharing (add-board-sharing): the git
# layer and its version floor, model detection, host-model init, join and
# repair, host-model sync, init --remote, init --into-host and the remote
# command, in process, through the built CLI and as child processes.
# check-git-floor runs exactly these on git $(GIT_FLOOR). Paths only, no
# patterns: src/__tests__/git-floor.test.ts checks that every file listed
# exists and that none of the sharing test files is missing from the list,
# so the target cannot silently run nothing.
SHARING_TESTS := \
	src/board/__tests__/git.test.ts \
	src/board/__tests__/model.test.ts \
	src/board/__tests__/init.test.ts \
	src/board/__tests__/host-init.test.ts \
	src/board/__tests__/host-sync.test.ts \
	src/board/__tests__/standalone-sync-fixture.test.ts \
	src/board/__tests__/init-remote.test.ts \
	src/board/__tests__/into-host.test.ts \
	src/board/__tests__/remote.test.ts \
	src/cli/__tests__/init-cli.test.ts \
	src/cli/__tests__/host-sync-cli.test.ts \
	src/cli/__tests__/init-remote-cli.test.ts \
	src/cli/__tests__/into-host-cli.test.ts \
	src/cli/__tests__/remote-cli.test.ts \
	src/__tests__/host-sync-clones.test.ts \
	src/__tests__/host-sync-crash.test.ts \
	src/__tests__/host-sync-writers.test.ts \
	src/__tests__/into-host-clones.test.ts \
	src/__tests__/into-host-race.test.ts \
	src/__tests__/git-floor.test.ts

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

# Runs the sharing tests (SHARING_TESTS) on the oldest git the host model
# supports, built from source in the dev-git-floor image (Dockerfile.dev
# with GIT_VERSION set; docker-compose.yml) on the oldest supported Node,
# so the declared git floor is actually tested and not only the distro git
# of the dev image. Before the tests the container checks that the git on
# its PATH is a $(GIT_FLOOR) release, so a build that silently kept the
# distro git fails here instead of passing on a newer git. Run it for
# changes that touch sharing (CONTRIBUTING.md, "Checks").
check-git-floor:
	docker compose run --rm --build dev-git-floor sh -c \
		'v="$$(git --version)"; case "$$v" in "git version $(GIT_FLOOR)."*) ;; *) echo "check-git-floor: expected git $(GIT_FLOOR).x on the PATH, found: $$v" >&2; exit 1;; esac \
		&& make install && make test-sharing'; \
	status=$$?; docker compose down --volumes --remove-orphans >/dev/null 2>&1; exit $$status

# Runs only the sharing tests, without coverage: the thresholds in
# vitest.config.ts are for the whole suite, which make check runs. Usable
# on the host too, with whatever git is installed.
test-sharing:
	npx vitest run $(SHARING_TESTS)

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
	if LC_ALL=C grep -RIl "$$pattern" adr openspec README.md CLAUDE.md CONTRIBUTING.md STATUS.md src; then \
		echo "non-ASCII byte(s) found in the file(s) listed above" >&2; \
		exit 1; \
	fi; \
	echo "No non-ASCII bytes found."

validate-specs:
	npx --yes @fission-ai/openspec@latest validate --all --no-interactive
