// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {ProposalCreatedHead} from "../../src/libraries/ProposalCreatedHead.sol";
import {DemoGovernor} from "../../src/demo/DemoGovernor.sol";
import {DemoVotesToken} from "../../src/demo/DemoVotesToken.sol";

contract HeadReader {
    function read(bytes calldata data)
        external
        pure
        returns (bool ok, uint256 proposalId, address proposer, uint64 voteStart, uint64 voteEnd)
    {
        return ProposalCreatedHead.read(data);
    }
}

/// @notice Header-word parsing of ProposalCreated data: real governor logs and fuzzed tuples of any shape.
contract ProposalCreatedHeadTest is Test {
    HeadReader internal reader;

    function setUp() public {
        reader = new HeadReader();
    }

    function _encode(
        uint256 pid,
        address proposer,
        address[] memory targets,
        uint256[] memory values,
        string[] memory signatures,
        bytes[] memory calldatas,
        uint256 voteStart,
        uint256 voteEnd,
        string memory description
    ) internal pure returns (bytes memory) {
        return abi.encode(pid, proposer, targets, values, signatures, calldatas, voteStart, voteEnd, description);
    }

    function test_readsRealGovernorLog() public {
        DemoVotesToken token = new DemoVotesToken("T", "T", true);
        DemoGovernor gov = new DemoGovernor("G", IVotes(address(token)), 60, 1800, 1);
        address[] memory targets = new address[](2);
        targets[0] = address(token);
        targets[1] = address(gov);
        uint256[] memory values = new uint256[](2);
        bytes[] memory calldatas = new bytes[](2);
        calldatas[0] = hex"deadbeef";
        calldatas[1] = new bytes(300);
        vm.recordLogs();
        uint256 pid = gov.propose(targets, values, calldatas, "A long description\nwith lines");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 1, "no indexed fields");
        (bool ok, uint256 id, address who, uint64 start, uint64 end) = reader.read(logs[0].data);
        assertTrue(ok);
        assertEq(id, pid);
        assertEq(who, address(this));
        assertEq(start, gov.proposalSnapshot(pid));
        assertEq(end, gov.proposalDeadline(pid));
    }

    function test_rejectsShortData() public view {
        (bool ok,,,,) = reader.read(new bytes(8 * 32 + 31));
        assertFalse(ok);
        (ok,,,,) = reader.read("");
        assertFalse(ok);
    }

    function test_rejectsDirtyProposerWord() public view {
        bytes memory data = new bytes(9 * 32);
        assembly {
            mstore(add(data, 0x40), not(0))
        }
        (bool ok,,,,) = reader.read(data);
        assertFalse(ok);
    }

    function test_rejectsEndBeforeStart() public view {
        bytes memory data = _encode(
            1, address(1), new address[](0), new uint256[](0), new string[](0), new bytes[](0), 100, 99, ""
        );
        (bool ok,,,,) = reader.read(data);
        assertFalse(ok);
    }

    function test_rejectsBoundsAbove64Bits() public view {
        bytes memory data = _encode(
            1,
            address(1),
            new address[](0),
            new uint256[](0),
            new string[](0),
            new bytes[](0),
            uint256(type(uint64).max) + 1,
            uint256(type(uint64).max) + 2,
            ""
        );
        (bool ok,,,,) = reader.read(data);
        assertFalse(ok);
    }

    struct Shape {
        uint256 pid;
        address proposer;
        uint64 voteStart;
        uint64 voteEnd;
        uint8 n;
        string description;
        bytes calldataItem;
    }

    struct Arrays {
        address[] targets;
        uint256[] values;
        string[] signatures;
        bytes[] calldatas;
    }

    function _encodeShape(Shape memory s) internal pure returns (bytes memory) {
        Arrays memory a = Arrays(new address[](s.n), new uint256[](s.n), new string[](s.n), new bytes[](s.n));
        for (uint256 i; i < s.n; ++i) {
            a.targets[i] = address(uint160(uint256(keccak256(abi.encode(i, s.pid)))));
            a.values[i] = i * 1e18;
            a.signatures[i] = i % 2 == 0 ? "" : s.description;
            a.calldatas[i] = s.calldataItem;
        }
        return abi.encode(
            s.pid, s.proposer, a.targets, a.values, a.signatures, a.calldatas, s.voteStart, s.voteEnd, s.description
        );
    }

    function testFuzz_headIndependentOfTail(
        uint256 pid,
        address proposer,
        uint64 voteStart,
        uint32 duration,
        uint8 nTargets,
        string memory description,
        bytes memory oneCalldata
    ) public view {
        Shape memory s = Shape({
            pid: pid,
            proposer: proposer,
            voteStart: voteStart,
            voteEnd: uint64(bound(uint256(voteStart) + duration, voteStart, type(uint64).max)),
            n: uint8(bound(nTargets, 0, 12)),
            description: description,
            calldataItem: oneCalldata
        });
        (bool ok, uint256 id, address who, uint64 start, uint64 end) = reader.read(_encodeShape(s));
        assertTrue(ok);
        assertEq(id, pid);
        assertEq(who, proposer);
        assertEq(start, s.voteStart);
        assertEq(end, s.voteEnd);
    }

    function testFuzz_neverRevertsOnArbitraryBytes(bytes calldata junk) public view {
        reader.read(junk);
    }

    /// @dev Gas is flat in the size of the tail: the reader never touches it.
    function test_gasIndependentOfDescriptionLength() public view {
        bytes memory small = _encode(
            1, address(1), new address[](1), new uint256[](1), new string[](1), new bytes[](1), 10, 20, "x"
        );
        bytes memory large = _encode(
            1,
            address(1),
            new address[](40),
            new uint256[](40),
            new string[](40),
            new bytes[](40),
            10,
            20,
            string(new bytes(20_000))
        );
        uint256 g0 = gasleft();
        reader.read(small);
        uint256 gSmall = g0 - gasleft();
        g0 = gasleft();
        reader.read(large);
        uint256 gLarge = g0 - gasleft();
        // Only calldata cost differs (16 gas per non-zero byte, 4 per zero byte); allow for that.
        assertLt(gLarge, gSmall + large.length * 16);
    }
}
