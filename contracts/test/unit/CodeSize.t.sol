// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {DelegateFactory} from "../../src/DelegateFactory.sol";
import {Docket} from "../../src/Docket.sol";
import {MandateReactive} from "../../src/MandateReactive.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Test} from "forge-std/Test.sol";

/// @notice EIP-170 regression: the first Lasna deploy was refused with "max code size exceeded" (MandateReactive was
/// 29,049 bytes). forge's test EVM does not enforce the limit, so each deployed contract's code length is checked.
contract CodeSizeTest is Test {
    uint256 internal constant EIP170_LIMIT = 24_576;
    uint256 internal constant CRON100 = 0xb49937fb8970e19fd46d48f7e3fb00d659deac0347f79cd7cb542f0fc1503c70;

    function test_deployedContracts_fitEip170() public {
        IPayable proxy = IPayable(payable(address(0xBEEF)));
        vm.etch(address(proxy), hex"00");
        MandateReactive rc = new MandateReactive(address(this), CRON100, 300);
        Docket docket = new Docket(proxy, address(rc), address(this));
        DelegateFactory factory = new DelegateFactory(proxy);
        address delegate = factory.create(address(rc));

        assertLe(address(rc).code.length, EIP170_LIMIT, "MandateReactive");
        assertLe(address(docket).code.length, EIP170_LIMIT, "Docket");
        assertLe(address(factory).code.length, EIP170_LIMIT, "DelegateFactory");
        assertLe(delegate.code.length, EIP170_LIMIT, "Delegate");
    }
}
