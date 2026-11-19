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

.PHONY: workers-install workers-check juror replay e2e-anvil eval-fetch eval-run eval-report

workers-install:
	cd $(WORKERS) && pnpm install --frozen-lockfile

workers-check:
	cd $(WORKERS) && pnpm typecheck && pnpm lint && pnpm test

juror:
	@test -n "$(JUROR)" || (echo "usage: make juror JUROR=<1|2|3>" && exit 2)
	cd $(WORKERS) && JUROR_ID=$(JUROR) pnpm -s juror --once

replay:
	@test -n "$(CASE)" -a -n "$(JUROR)" || (echo "usage: make replay CASE=<id> JUROR=<1|2|3> [EVIDENCE=<dir>]" && exit 2)
	cd $(WORKERS) && $(EVIDENCE_ENV) pnpm -s replay --case $(CASE) --juror $(JUROR)

e2e-anvil:
	cd $(CONTRACTS) && forge build
	cd $(WORKERS) && pnpm -s e2e:anvil

eval-fetch:
	cd $(WORKERS) && pnpm -s eval:fetch

eval-run:
	cd $(WORKERS) && pnpm -s eval:run

eval-report:
	cd $(WORKERS) && pnpm -s eval:report
