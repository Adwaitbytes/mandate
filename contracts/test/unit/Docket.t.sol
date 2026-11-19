// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {Docket} from "../../src/Docket.sol";
import {IDocket} from "../../src/interfaces/IDocket.sol";
import {MockCallbackProxy} from "../harness/MockCallbackProxy.sol";

contract DocketTest is Test {
    MockCallbackProxy internal proxy;
    Docket internal docket;
    address internal rvm = makeAddr("rvm");
    address internal owner = makeAddr("owner");
    address internal juror = makeAddr("juror");
    address internal stranger = makeAddr("stranger");
    bytes32 internal constant MANDATE = keccak256("mandate v1");

    function setUp() public {
        proxy = new MockCallbackProxy();
        docket = new Docket(IPayable(payable(address(proxy))), rvm, owner);
        address[] memory js = new address[](1);
        js[0] = juror;
        vm.startPrank(owner);
        docket.addJurors(js);
        docket.setMandate(MANDATE, "ipfs://m1");
        vm.stopPrank();
    }

    function _payload(uint256 caseId) internal pure returns (bytes memory) {
        return abi.encodeCall(
            IDocket.openCase,
            (address(0), caseId, 1, 84_532, address(0xBEEF), 42, 100, 200, bytes32(uint256(7)), address(0xDE1E))
        );
    }

    function _open(uint256 caseId) internal returns (bool ok) {
        ok = proxy.deliver(rvm, address(docket), 600_000, _payload(caseId));
    }

    function _postAs(address who, uint256 caseId, uint8 support, uint16 conf, bytes32 rationale) internal {
        vm.prank(who);
        docket.postVerdict(caseId, support, conf, rationale, keccak256("m"), keccak256("p"), false);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // openCase

    function test_openCase_viaProxy_storesAndEmits() public {
        vm.recordLogs();
        assertTrue(_open(5));
        Docket.CaseRecord memory c = docket.getCase(5);
        assertEq(c.governor, address(0xBEEF));
        assertEq(c.proposalId, 42);
        assertEq(c.voteStart, 100);
        assertEq(c.voteEnd, 200);
        assertEq(c.delegate, address(0xDE1E));
        assertEq(c.mandateVersion, 1);
        assertEq(c.originTxHash, bytes32(uint256(7)));
        assertEq(docket.caseCount(), 1);
        assertEq(docket.caseIdAt(0), 5);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IDocket.CaseOpened.selector) {
                found = true;
                assertEq(uint256(logs[i].topics[1]), 5);
                (,,,,,,, uint256 version, bytes32 mHash) = abi.decode(
                    logs[i].data, (uint256, address, uint256, uint256, uint256, bytes32, address, uint256, bytes32)
                );
                assertEq(version, 1);
                assertEq(mHash, MANDATE);
            }
        }
        assertTrue(found);
    }

    function test_openCase_duplicate_isIdempotentAndReAcks() public {
        _open(5);
        vm.prank(owner);
        docket.setMandate(keccak256("v2"), "ipfs://m2");
        vm.recordLogs();
        assertTrue(_open(5));
        assertEq(docket.caseCount(), 1, "no second record");
        assertEq(docket.getCase(5).mandateVersion, 1, "pinned at first open");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 acks;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IDocket.CaseOpened.selector) ++acks;
        }
        assertEq(acks, 1, "duplicate re-emits the acknowledgement");
    }

    function test_openCase_rejectsDirectCall() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, stranger, address(proxy)));
        docket.openCase(rvm, 1, 1, 1, address(1), 1, 1, 2, bytes32(0), address(1));
    }

    function test_openCase_rejectsWrongReactiveSender() public {
        address other = makeAddr("otherRvm");
        assertFalse(proxy.deliver(other, address(docket), 600_000, _payload(1)));
        assertEq(docket.caseCount(), 0);
    }

    function test_openCase_rejectsCaseIdZero() public {
        assertFalse(_open(0));
    }

    function test_openCase_beforeAnyMandate_recordsVersionZero() public {
        Docket fresh = new Docket(IPayable(payable(address(proxy))), rvm, owner);
        assertTrue(proxy.deliver(rvm, address(fresh), 600_000, _payload(3)));
        assertEq(fresh.getCase(3).mandateVersion, 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // postVerdict

    function test_postVerdict_recordsAndEmits() public {
        _open(1);
        vm.expectEmit(address(docket));
        emit IDocket.Verdict(1, juror, 1, 8000, true, bytes32("r"), keccak256("m"), keccak256("p"));
        vm.prank(juror);
        docket.postVerdict(1, 1, 8000, bytes32("r"), keccak256("m"), keccak256("p"), true);
        Docket.VerdictRecord memory v = docket.getVerdict(1, juror);
        assertTrue(v.posted);
        assertEq(v.support, 1);
        assertEq(v.confidenceBps, 8000);
        assertTrue(v.injectionFlag);
        assertEq(docket.getCase(1).verdictCount, 1);
    }

    function test_postVerdict_onlyJuror() public {
        _open(1);
        vm.expectRevert(abi.encodeWithSelector(Docket.NotJuror.selector, stranger));
        _postAs(stranger, 1, 1, 8000, bytes32("r"));
    }

    function test_postVerdict_oncePerCase() public {
        _open(1);
        _postAs(juror, 1, 1, 8000, bytes32("r"));
        vm.expectRevert(abi.encodeWithSelector(Docket.AlreadyPosted.selector, 1, juror));
        _postAs(juror, 1, 0, 8000, bytes32("r2"));
    }

    function test_postVerdict_unknownCase() public {
        vm.expectRevert(abi.encodeWithSelector(Docket.UnknownCase.selector, 9));
        _postAs(juror, 9, 1, 8000, bytes32("r"));
    }

    function test_postVerdict_validatesFields() public {
        _open(1);
        vm.expectRevert(abi.encodeWithSelector(Docket.InvalidSupport.selector, 3));
        _postAs(juror, 1, 3, 8000, bytes32("r"));
        vm.expectRevert(abi.encodeWithSelector(Docket.InvalidConfidence.selector, 10_001));
        _postAs(juror, 1, 1, 10_001, bytes32("r"));
        vm.expectRevert(Docket.ZeroHash.selector);
        _postAs(juror, 1, 1, 8000, bytes32(0));
    }

    function test_removedJuror_cannotPost_butRecordStays() public {
        _open(1);
        _open(2);
        _postAs(juror, 1, 1, 8000, bytes32("r"));
        address[] memory js = new address[](1);
        js[0] = juror;
        vm.prank(owner);
        docket.removeJurors(js);
        assertEq(docket.jurors().length, 0);
        assertTrue(docket.getVerdict(1, juror).posted);
        vm.expectRevert(abi.encodeWithSelector(Docket.NotJuror.selector, juror));
        _postAs(juror, 2, 1, 8000, bytes32("r"));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Owner actions

    function test_veto_onceAndOnlyOwner() public {
        _open(1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        docket.veto(1);
        vm.expectEmit(address(docket));
        emit IDocket.Vetoed(1);
        vm.prank(owner);
        docket.veto(1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Docket.OwnerAlreadyActed.selector, 1));
        docket.overrideVote(1, 1);
    }

    function test_override_recordsSupport() public {
        _open(1);
        vm.expectEmit(address(docket));
        emit IDocket.Overridden(1, 2);
        vm.prank(owner);
        docket.overrideVote(1, 2);
        Docket.CaseRecord memory c = docket.getCase(1);
        assertEq(uint8(c.ownerAction), uint8(Docket.OwnerAction.Override));
        assertEq(c.overrideSupport, 2);
    }

    function test_override_validates() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Docket.UnknownCase.selector, 1));
        docket.overrideVote(1, 1);
        _open(1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Docket.InvalidSupport.selector, 7));
        docket.overrideVote(1, 7);
    }

    function test_setMandate_versionsAndValidates() public {
        vm.startPrank(owner);
        vm.expectEmit(address(docket));
        emit IDocket.MandateSet(2, keccak256("v2"), "ipfs://m2");
        docket.setMandate(keccak256("v2"), "ipfs://m2");
        assertEq(docket.mandateVersion(), 2);
        assertEq(docket.getMandate(1).mandateHash, MANDATE);
        assertEq(docket.getMandate(2).uri, "ipfs://m2");
        vm.expectRevert(Docket.ZeroHash.selector);
        docket.setMandate(bytes32(0), "x");
        vm.expectRevert(Docket.EmptyUri.selector);
        docket.setMandate(keccak256("v3"), "");
        vm.stopPrank();
    }

    function test_addJurors_limitsAndDuplicates() public {
        address[] memory js = new address[](1);
        js[0] = juror;
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(Docket.JurorAlreadyRegistered.selector, juror));
        docket.addJurors(js);
        js[0] = address(0);
        vm.expectRevert(Docket.ZeroAddress.selector);
        docket.addJurors(js);
        address[] memory many = new address[](16);
        for (uint256 i; i < 16; ++i) {
            many[i] = address(uint160(0x1000 + i));
        }
        vm.expectRevert(Docket.TooManyJurors.selector);
        docket.addJurors(many);
        vm.stopPrank();
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(Docket.ZeroAddress.selector);
        new Docket(IPayable(payable(address(0))), rvm, owner);
        vm.expectRevert(Docket.ZeroAddress.selector);
        new Docket(IPayable(payable(address(proxy))), address(0), owner);
    }

    function test_callbackSenderIsImmutableReactive() public view {
        assertEq(AbstractCallback(payable(address(docket)))._CALLBACK_SENDER(), rvm);
        assertEq(address(docket._SERVICE_PROVIDER()), address(proxy));
    }

    function test_coverDebt_withNoDebt_isNoop() public {
        docket.coverDebt();
    }
}
