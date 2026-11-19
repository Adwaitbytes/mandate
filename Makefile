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
