// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Mock tFRONG for testnet 46630 only — never deployed to mainnet.
 * Faucet drip sized for ~100 plays, once per address per 24h.
 */
contract MockFRONG is ERC20 {
    uint256 public constant DRIP_AMOUNT = 1_000e18;
    uint256 public constant DRIP_COOLDOWN = 1 days;

    mapping(address => uint256) public lastDrip;

    constructor() ERC20("Mock FRONG", "tFRONG") {}

    function drip() external {
        require(block.timestamp >= lastDrip[msg.sender] + DRIP_COOLDOWN, "tFRONG: cooldown");
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP_AMOUNT);
    }
}
