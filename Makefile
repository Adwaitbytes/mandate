# Mandate. Contracts live in contracts/ (Foundry). Live deploys sign with the omni-deployer keystore only.
SHELL := /bin/bash
CONTRACTS := contracts
SCRIPT := script/DeployMandate.s.sol
ACCOUNT := omni-deployer

.PHONY: build test fmt check deploy-reactive deploy-hearing deploy-governor wire

build:
	cd $(CONTRACTS) && forge build

test:
	cd $(CONTRACTS) && forge test

fmt:
	cd $(CONTRACTS) && forge fmt

check:
	cd $(CONTRACTS) && forge fmt --check && forge build && forge test

deploy-reactive:
	cd $(CONTRACTS) && set -a && source .env && set +a && forge script $(SCRIPT):DeployReactive --rpc-url $$REACTIVE_RPC --account $(ACCOUNT) --broadcast

deploy-hearing:
	cd $(CONTRACTS) && set -a && source .env && set +a && forge script $(SCRIPT):DeployHearing --rpc-url $$HEARING_RPC --account $(ACCOUNT) --broadcast

deploy-governor:
	cd $(CONTRACTS) && set -a && source .env && set +a && forge script $(SCRIPT):DeployGovernorChain --rpc-url $$GOVERNOR_RPC --account $(ACCOUNT) --broadcast

wire:
	cd $(CONTRACTS) && set -a && source .env && set +a && forge script $(SCRIPT):WireReactive --rpc-url $$REACTIVE_RPC --account $(ACCOUNT) --broadcast

# Jurors (workers/, Node 26 + pnpm). See docs/JURORS.md.
WORKERS := workers
EVIDENCE_ENV = $(if $(EVIDENCE),EVIDENCE_DIR=$(abspath $(EVIDENCE)),)

.PHONY: workers-install workers-check juror replay e2e-anvil eval-fetch eval-run eval-heuristic eval-report

workers-install:
	cd $(WORKERS) && pnpm install --frozen-lockfile

workers-check:
	cd $(WORKERS) && pnpm typecheck && pnpm lint && pnpm test

juror:
	@test -n "$(JUROR)" || (echo "usage: make juror JUROR=<1|2|3>" && exit 2)
	cd $(WORKERS) && JUROR_ID=$(JUROR) pnpm --silent juror --once

replay:
	@test -n "$(CASE)" -a -n "$(JUROR)" || (echo "usage: make replay CASE=<id> JUROR=<1|2|3> [EVIDENCE=<dir>]" && exit 2)
	cd $(WORKERS) && $(EVIDENCE_ENV) pnpm --silent replay --case $(CASE) --juror $(JUROR)

e2e-anvil:
	cd $(CONTRACTS) && forge build
	cd $(WORKERS) && pnpm --silent e2e:anvil

eval-fetch:
	cd $(WORKERS) && pnpm --silent eval:fetch

eval-run:
	cd $(WORKERS) && pnpm --silent eval:run

eval-heuristic:
	cd $(WORKERS) && pnpm --silent eval:heuristic

eval-report:
	cd $(WORKERS) && pnpm --silent eval:report

# Live jurors under tools/live/supervise.sh (restart with backoff, logs in evidence/live/juror-<n>.log).
# JUROR_WORKERS points at a worktree pinned to a commit; default this repo's workers/.
JUROR_WORKERS ?= $(abspath $(WORKERS))
.PHONY: jurors-up jurors-down jurors-status

jurors-up:
	@tools/live/jurors.sh up "$(JUROR_WORKERS)"

jurors-down:
	@tools/live/jurors.sh down

jurors-status:
	@tools/live/jurors.sh status

# CI, locally: the steps of .github/workflows/ci.yml in the same order. Only the artifact uploads and the
# Playwright run against the Vercel preview (preview-e2e.yml) are GitHub-only; `make smoke SMOKE_URL=...` runs
# the latter against any URL (the site has no production deployment yet).
CI_NODE_WORKSPACES := web workers
SLITHER_JSON ?= $(or $(TMPDIR),/tmp)/mandate-slither.json
SMOKE_URL ?=
.PHONY: ci ci-writing ci-secrets ci-contracts ci-slither ci-node smoke

ci: ci-writing ci-secrets ci-contracts ci-slither ci-node

ci-writing:
	node --test tools/check-writing.test.mjs
	node tools/check-writing.mjs

ci-secrets:
	gitleaks git --redact --no-banner --exit-code 1 .

ci-contracts:
	cd $(CONTRACTS) && forge fmt --check
	cd $(CONTRACTS) && forge build --deny warnings
	cd $(CONTRACTS) && forge test
	cd $(CONTRACTS) && forge coverage --report summary \
		--no-match-contract "Fork|CodeSize" --no-match-coverage "(test|script|lib)/"

ci-slither:
	rm -f $(SLITHER_JSON)
	cd $(CONTRACTS) && slither . --config-file ../slither.config.json --json $(SLITHER_JSON)
	node tools/slither-gate.mjs $(SLITHER_JSON) tools/slither-triage.json

ci-node:
	for w in $(CI_NODE_WORKSPACES); do \
		echo "== $$w"; \
		(cd $$w && pnpm install --frozen-lockfile --allow-build esbuild && pnpm run --if-present lint && pnpm run typecheck && pnpm run test) || exit 1; \
	done

smoke:
	@test -n "$(SMOKE_URL)" || (echo "usage: make smoke SMOKE_URL=<deployment url>" && exit 2)
	cd tools/smoke && pnpm install --frozen-lockfile && \
		SMOKE_URL=$(SMOKE_URL) SMOKE_TITLE=Mandate SMOKE_TEXT=juror pnpm run test
