// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Reads the fixed head words of a `ProposalCreated` log without decoding the dynamic tail.
/// @notice OpenZeppelin Governor and Compound Governor Bravo both emit
/// `ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)` with no indexed
/// fields, so every value is in `data`. The head is nine 32-byte words: static values in place and offsets for the
/// five dynamic values. Words 0, 1, 6 and 7 are proposalId, proposer, voteStart and voteEnd. Reading only those keeps
/// the cost flat no matter how long the description or the calldata arrays are.
library ProposalCreatedHead {
    /// @dev Nine head words.
    uint256 internal constant HEAD_LENGTH = 9 * 32;

    /// @notice Parses the head words.
    /// @return ok False when the data is too short, the proposer word is not a clean address, either vote bound does
    /// not fit in 64 bits, or voteEnd precedes voteStart. Callers must ignore the log when false.
    function read(bytes calldata data)
        internal
        pure
        returns (bool ok, uint256 proposalId, address proposer, uint64 voteStart, uint64 voteEnd)
    {
        if (data.length < HEAD_LENGTH) return (false, 0, address(0), 0, 0);
        uint256 rawProposer;
        uint256 rawStart;
        uint256 rawEnd;
        assembly ("memory-safe") {
            proposalId := calldataload(data.offset)
            rawProposer := calldataload(add(data.offset, 0x20))
            rawStart := calldataload(add(data.offset, 0xc0))
            rawEnd := calldataload(add(data.offset, 0xe0))
        }
        if (rawProposer >> 160 != 0 || rawStart > type(uint64).max || rawEnd > type(uint64).max || rawEnd < rawStart) {
            return (false, 0, address(0), 0, 0);
        }
        return (true, proposalId, address(uint160(rawProposer)), uint64(rawStart), uint64(rawEnd));
    }
}
