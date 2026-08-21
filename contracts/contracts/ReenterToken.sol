// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { FrongEntry } from "./FrongEntry.sol";

/**
 * Test-only malicious ERC-20: transferFrom re-enters the entry contract.
 * Used to prove the ReentrancyGuard on FrongEntry.play actually blocks
 * re-entrancy (real EVM execution, not a mock).
 */
contract ReenterToken is ERC20 {
    FrongEntry public entry;

    constructor() ERC20("Reenter", "RE") {}

    function setEntry(address entry_) external {
        entry = FrongEntry(entry_);
    }

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool ok = super.transferFrom(from, to, value);
        if (address(entry) != address(0)) {
            entry.play(bytes32(uint256(1)));
        }
        return ok;
    }
}
