// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Test-only fee-on-transfer ERC-20: every transfer/transferFrom moves only
 * (1 - TAX_BPS/10_000) of the requested amount and burns the tax. Used to prove
 * FrongEntry.strictReceived balance-delta accounting detects the shortfall
 * (real EVM execution, not a mock). Mint and burn are exact (no tax).
 */
contract MockTaxToken is ERC20 {
    uint256 public constant TAX_BPS = 100; // 1% fee on every transfer

    constructor() ERC20("Mock Tax Token", "TAX") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * TAX_BPS) / 10_000;
        uint256 net = value - fee;
        super._update(from, to, net);
        super._update(from, address(0), fee);
    }
}
