// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Delegate} from "../../src/Delegate.sol";
import {DelegateFactory} from "../../src/DelegateFactory.sol";
import {DemoVotesToken} from "../../src/demo/DemoVotesToken.sol";
import {IDelegate} from "../../src/interfaces/IDelegate.sol";
import {MockCallbackProxy} from "../harness/MockCallbackProxy.sol";
import {MockGovernor} from "../harness/MockGovernor.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Test} from "forge-std/Test.sol";

contract DelegateTest is Test {
    MockCallbackProxy internal proxy;
    DelegateFactory internal factory;
    Delegate internal delegate;
    MockGovernor internal gov;
    address internal rvm = makeAddr("rvm");
    address internal user = makeAddr("user");

    function setUp() public {
        proxy = new MockCallbackProxy();
        factory = new DelegateFactory(IPayable(payable(address(proxy))));
        vm.deal(user, 1 ether);
        vm.prank(user);
        delegate = Delegate(payable(factory.create{value: 0.5 ether}(rvm)));
        gov = new MockGovernor();
    }

    function _cast(uint256 caseId, uint256 seq, uint8 support) internal returns (bool ok) {
        bytes memory payload = abi.encodeCall(
            IDelegate.cast, (address(0), caseId, seq, address(gov), 77, support, "Mandate case 1, mandate v1")
        );
        ok = proxy.deliver(rvm, address(delegate), 600_000, payload);
    }

    function test_cast_activeProposal_votesAndAcks() public {
        vm.expectEmit(address(delegate));
        emit IDelegate.Cast(1, address(gov), 77, 1, 1, 42);
        assertTrue(_cast(1, 1, 1));
        assertEq(gov.votes(), 1);
        assertEq(gov.lastSupport(), 1);
        assertEq(gov.lastReason(), "Mandate case 1, mandate v1");
        Delegate.Receipt memory r = delegate.receiptOf(1);
        assertTrue(r.cast);
        assertEq(r.weight, 42);
        assertEq(r.governor, address(gov));
    }

    function test_cast_duplicateDelivery_isIdempotentAndReAcks() public {
        _cast(1, 1, 1);
        vm.expectEmit(address(delegate));
        emit IDelegate.Cast(1, address(gov), 77, 2, 1, 42);
        assertTrue(_cast(1, 2, 0));
        assertEq(gov.votes(), 1, "no second vote");
    }

    function test_cast_pending_reportsNotYetActive() public {
        gov.setState(0);
        vm.expectEmit(address(delegate));
        emit IDelegate.NotActive(1, 3, uint8(IDelegate.Refusal.NotYetActive), 0);
        assertTrue(_cast(1, 3, 1));
        assertEq(gov.votes(), 0);
        assertFalse(delegate.receiptOf(1).cast);
    }

    function test_cast_everyPostActiveState_reportsEnded() public {
        for (uint8 s = 2; s <= 7; ++s) {
            gov.setState(s);
            vm.expectEmit(address(delegate));
            emit IDelegate.NotActive(s, 1, uint8(IDelegate.Refusal.Ended), s);
            _cast(s, 1, 1);
        }
        assertEq(gov.votes(), 0);
    }

    function test_cast_stateReverts_reportsUnavailable() public {
        gov.setStateReverts(true);
        vm.expectEmit(address(delegate));
        emit IDelegate.NotActive(1, 1, uint8(IDelegate.Refusal.StateUnavailable), type(uint8).max);
        assertTrue(_cast(1, 1, 1));
    }

    function test_cast_governorReverts_reportsCastReverted_withoutReverting() public {
        gov.setCastReverts(true);
        vm.expectEmit(address(delegate));
        emit IDelegate.NotActive(1, 1, uint8(IDelegate.Refusal.CastReverted), 1);
        assertTrue(_cast(1, 1, 1), "callback itself succeeds");
        assertEq(proxy.failures(), 0);
    }

    function test_cast_alreadyVotedElsewhere_acksWithoutDoubleVote() public {
        gov.setAlreadyVoted(true);
        vm.expectEmit(address(delegate));
        emit IDelegate.Cast(1, address(gov), 77, 1, 1, 0);
        _cast(1, 1, 1);
        assertEq(gov.votes(), 0);
        assertTrue(delegate.receiptOf(1).cast);
    }

    function test_cast_bravoLikeGovernor_withoutHasVoted() public {
        gov.setBravoLike(true);
        assertTrue(_cast(1, 1, 2));
        assertEq(gov.votes(), 1);
        assertEq(gov.lastSupport(), 2);
    }

    function test_cast_invalidSupport_refused() public {
        vm.expectEmit(address(delegate));
        emit IDelegate.NotActive(1, 1, uint8(IDelegate.Refusal.InvalidSupport), type(uint8).max);
        _cast(1, 1, 3);
        assertEq(gov.votes(), 0);
    }

    function test_paused_refusesAndResumes() public {
        vm.prank(user);
        delegate.setPaused(true);
        vm.expectEmit(address(delegate));
        emit IDelegate.NotActive(1, 1, uint8(IDelegate.Refusal.Paused), type(uint8).max);
        _cast(1, 1, 1);
        vm.prank(user);
        delegate.setPaused(false);
        _cast(1, 2, 1);
        assertEq(gov.votes(), 1);
    }

    function test_cast_rejectsDirectCall() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), address(proxy)));
        delegate.cast(rvm, 1, 1, address(gov), 77, 1, "");
    }

    function test_cast_rejectsOtherReactiveThroughProxy() public {
        bytes memory payload = abi.encodeCall(IDelegate.cast, (address(0), 1, 1, address(gov), 77, 1, ""));
        assertFalse(proxy.deliver(makeAddr("evilRvm"), address(delegate), 600_000, payload));
        assertEq(gov.votes(), 0);
    }

    function test_ownerFunctions_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Delegate.NotOwner.selector, address(this)));
        delegate.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Delegate.NotOwner.selector, address(this)));
        delegate.withdraw(1, payable(address(this)));
    }

    function test_withdraw_native() public {
        address payable to = payable(makeAddr("to"));
        vm.prank(user);
        delegate.withdraw(0.2 ether, to);
        assertEq(to.balance, 0.2 ether);
        assertEq(address(delegate).balance, 0.3 ether);
    }

    function test_heldTokens_delegateAndWithdraw() public {
        DemoVotesToken token = new DemoVotesToken("T", "T", false);
        vm.prank(user);
        token.faucet();
        vm.prank(user);
        IERC20(address(token)).transfer(address(delegate), 100 ether);
        vm.prank(user);
        delegate.delegateHeldVotes(IVotes(address(token)), address(delegate));
        vm.roll(block.number + 1);
        assertEq(token.getVotes(address(delegate)), 100 ether);
        vm.prank(user);
        delegate.delegateHeldVotes(IVotes(address(token)), user);
        vm.prank(user);
        delegate.withdrawToken(IERC20(address(token)), user, 100 ether);
        assertEq(token.balanceOf(user), token.FAUCET_AMOUNT());
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Factory

    function test_factory_predictsAddressAndBindsImmutables() public view {
        assertEq(factory.predict(user, rvm), address(delegate));
        assertEq(factory.delegateOf(user, rvm), address(delegate));
        assertEq(delegate.owner(), user);
        assertEq(delegate._CALLBACK_SENDER(), rvm);
        assertEq(address(delegate._SERVICE_PROVIDER()), address(proxy));
        assertEq(address(delegate).balance, 0.5 ether);
    }

    function test_factory_onePerOwnerAndReactive() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(DelegateFactory.AlreadyCreated.selector, address(delegate)));
        factory.create(rvm);
        vm.prank(user);
        address second = factory.create(makeAddr("otherRvm"));
        assertTrue(second != address(delegate));
    }

    function test_factory_rejectsZero() public {
        vm.expectRevert(DelegateFactory.ZeroAddress.selector);
        factory.create(address(0));
        vm.expectRevert(DelegateFactory.ZeroAddress.selector);
        new DelegateFactory(IPayable(payable(address(0))));
    }
}
