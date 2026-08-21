// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * FRONG entry payment. FRONG flows exactly one way: player -> this contract.
 * The game never mints, burns, pays out, or withdraws FRONG. Immutable, no
 * proxy; price is operator-settable storage; fees accumulate until swept.
 *
 * Treasury/gas accounting: collected FRONG is swept 70% to treasury and the
 * remainder (30% + rounding dust) to gasReserve (the gas-sponsorship float).
 * Both destinations rotate via a 2-step propose/accept with a 24h timelock.
 * strictReceived enables balance-delta accounting so fee-on-transfer tokens
 * are rejected instead of silently under-collecting the advertised price.
 */
contract FrongEntry is ReentrancyGuard {
    uint256 public constant ROTATION_TIMELOCK = 24 hours;
    uint256 public constant OWNER_TIMELOCK = 24 hours;

    // Price bounds (D2): 1 FRONG .. 1,000,000 FRONG. setPrice is admin-only
    // (multisig/timelock-compatible 2-step owner) and never leaves this range.
    uint256 public constant MIN_PRICE = 1e18;
    uint256 public constant MAX_PRICE = 1_000_000e18;

    event Paid(address indexed player, bytes32 indexed paymentId, uint256 amount);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event OwnerProposed(address indexed proposed, uint256 proposedAt);
    event OwnerAccepted(address indexed previous, address indexed accepted, uint256 acceptedAt);
    event Swept(
        address indexed treasury,
        address indexed gasReserve,
        uint256 toTreasury,
        uint256 toGas,
        uint256 timestamp
    );
    event TreasuryProposed(address indexed proposed, uint256 proposedAt);
    event TreasuryAccepted(address indexed previous, address indexed accepted, uint256 acceptedAt);
    event GasReserveProposed(address indexed proposed, uint256 proposedAt);
    event GasReserveAccepted(address indexed previous, address indexed accepted, uint256 acceptedAt);

    address public immutable frong;
    bool public immutable strictReceived;
    address public owner;
    address public pendingOwner;
    uint256 public ownerProposedAt;
    uint256 public price;
    bool public paused;

    address public treasury;
    address public gasReserve;
    address public pendingTreasury;
    address public pendingGasReserve;
    uint256 public treasuryProposedAt;
    uint256 public gasReserveProposedAt;

    modifier onlyOwner() {
        require(msg.sender == owner, "Entry: not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Entry: paused");
        _;
    }

    constructor(
        address frong_,
        uint256 price_,
        address treasury_,
        address gasReserve_,
        bool strictReceived_
    ) {
        require(frong_ != address(0), "Entry: zero frong");
        require(price_ >= MIN_PRICE && price_ <= MAX_PRICE, "Entry: price bounds");
        require(treasury_ != address(0), "Entry: zero treasury");
        require(gasReserve_ != address(0), "Entry: zero gas reserve");
        frong = frong_;
        strictReceived = strictReceived_;
        owner = msg.sender;
        price = price_;
        treasury = treasury_;
        gasReserve = gasReserve_;
    }

    /**
     * Price change (D2): admin-only, bounded, with an old->new audit event.
     * The admin itself is a 2-step, timelock-compatible owner (Safe-ready).
     */
    function setPrice(uint256 newPrice) external onlyOwner {
        require(newPrice >= MIN_PRICE && newPrice <= MAX_PRICE, "Entry: price bounds");
        uint256 oldPrice = price;
        price = newPrice;
        emit PriceUpdated(oldPrice, newPrice);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
    }

    /** 2-step owner rotation (24h timelock). The successor claims the role. */
    function proposeOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Entry: zero owner");
        pendingOwner = newOwner;
        ownerProposedAt = block.timestamp;
        emit OwnerProposed(newOwner, block.timestamp);
    }

    function acceptOwner() external {
        require(pendingOwner != address(0), "Entry: no pending owner");
        require(msg.sender == pendingOwner, "Entry: not pending owner");
        require(block.timestamp >= ownerProposedAt + OWNER_TIMELOCK, "Entry: owner timelock");
        address previous = owner;
        owner = pendingOwner;
        delete pendingOwner;
        ownerProposedAt = 0;
        emit OwnerAccepted(previous, owner, block.timestamp);
    }

    function proposeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Entry: zero treasury");
        pendingTreasury = newTreasury;
        treasuryProposedAt = block.timestamp;
        emit TreasuryProposed(newTreasury, block.timestamp);
    }

    function acceptTreasury() external onlyOwner {
        require(pendingTreasury != address(0), "Entry: no pending treasury");
        require(block.timestamp >= treasuryProposedAt + ROTATION_TIMELOCK, "Entry: treasury timelock");
        address previous = treasury;
        treasury = pendingTreasury;
        delete pendingTreasury;
        treasuryProposedAt = 0;
        emit TreasuryAccepted(previous, treasury, block.timestamp);
    }

    function proposeGasReserve(address newGasReserve) external onlyOwner {
        require(newGasReserve != address(0), "Entry: zero gas reserve");
        pendingGasReserve = newGasReserve;
        gasReserveProposedAt = block.timestamp;
        emit GasReserveProposed(newGasReserve, block.timestamp);
    }

    function acceptGasReserve() external onlyOwner {
        require(pendingGasReserve != address(0), "Entry: no pending gas reserve");
        require(block.timestamp >= gasReserveProposedAt + ROTATION_TIMELOCK, "Entry: gas reserve timelock");
        address previous = gasReserve;
        gasReserve = pendingGasReserve;
        delete pendingGasReserve;
        gasReserveProposedAt = 0;
        emit GasReserveAccepted(previous, gasReserve, block.timestamp);
    }

    /**
     * Pulls exactly price FRONG from the player. paymentId is a
     * client-generated unique id the server later binds to the payment tx
     * hash - one session per payment. amount in the Paid event is the price
     * charged AT PAYMENT TIME (this call), not the deploy-time price.
     */
    function play(bytes32 paymentId) external nonReentrant whenNotPaused {
        uint256 received = price;
        if (strictReceived) {
            uint256 beforeBalance = IERC20(frong).balanceOf(address(this));
            require(IERC20(frong).transferFrom(msg.sender, address(this), price), "Entry: transfer failed");
            uint256 afterBalance = IERC20(frong).balanceOf(address(this));
            received = afterBalance - beforeBalance;
            require(received == price, "Entry: fee-on-transfer");
        } else {
            require(IERC20(frong).transferFrom(msg.sender, address(this), price), "Entry: transfer failed");
        }
        emit Paid(msg.sender, paymentId, received);
    }

    /**
     * Sweeps the accumulated FRONG balance: 70% to treasury, the remainder
     * (30% + rounding dust) to gasReserve. No player payouts ever.
     */
    function sweep() external onlyOwner {
        uint256 balance = IERC20(frong).balanceOf(address(this));
        require(balance > 0, "Entry: nothing to sweep");
        uint256 toTreasury = (balance * 70) / 100;
        uint256 toGas = balance - toTreasury;
        require(IERC20(frong).transfer(treasury, toTreasury), "Entry: treasury sweep failed");
        require(IERC20(frong).transfer(gasReserve, toGas), "Entry: gas sweep failed");
        emit Swept(treasury, gasReserve, toTreasury, toGas, block.timestamp);
    }
}
