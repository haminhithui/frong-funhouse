// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC721 } from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * ERC-721 trophy: the only player reward. Mint is minter-only (the team
 * server key); players can never call mint. Token ids are server-assigned
 * and collision-free. Metadata URI is final at mint (pinned before the mint
 * tx). On-chain attestation per token makes every claimed score
 * recomputable against the shared deterministic sim.
 */
contract FrongTrophy is ERC721, Pausable, ReentrancyGuard {
    struct Attestation {
        uint8 tier;
        uint16 score;
        uint8 fliesCaught;
        bytes32 seedCommitment;
        bytes32 inputLogHash;
        uint256 timestamp;
        bytes32 buildHash;
    }

    event TrophyMinted(address indexed to, uint256 indexed tokenId, Attestation attestation, string tokenURI_);
    event MinterUpdated(address indexed account, bool enabled);
    event RateCapUpdated(uint256 oldCap, uint256 newCap);
    event PauseStateChanged(bool paused);
    event AdminProposed(address indexed proposed, uint256 proposedAt);
    event AdminAccepted(address indexed previous, address indexed accepted, uint256 acceptedAt);

    // Attestation bounds (mirror the deterministic sim: max score 109, 45 flies, 5 tiers).
    uint16 public constant MAX_SCORE = 109;
    uint8 public constant MAX_FLIES = 45;
    uint8 public constant MAX_TIER = 5;
    // Two-step admin transfer timelock.
    uint256 public constant ADMIN_TIMELOCK = 24 hours;

    address public admin;
    address public pendingAdmin;
    uint256 public adminProposedAt;
    mapping(address => bool) public minters;
    mapping(uint256 => Attestation) public attestations;
    mapping(uint256 => string) private _tokenURIs;

    // Sliding-window mint rate cap (circuit breaker for a leaked minter key).
    uint256 public rateWindow = 1 hours;
    uint256 public rateCap = 100;
    uint256[] private _mintTimes;

    bool public immutable soulbound;

    modifier onlyAdmin() {
        require(msg.sender == admin, "Trophy: not admin");
        _;
    }

    modifier onlyMinter() {
        require(minters[msg.sender], "Trophy: not minter");
        _;
    }

    constructor(bool soulbound_) ERC721("FRONG Catch Trophy", "FRONGCATCH") {
        admin = msg.sender;
        soulbound = soulbound_;
    }

    function setMinter(address account, bool enabled) external onlyAdmin {
        minters[account] = enabled;
        emit MinterUpdated(account, enabled);
    }

    function setRateCap(uint256 cap) external onlyAdmin {
        uint256 oldCap = rateCap;
        rateCap = cap;
        emit RateCapUpdated(oldCap, cap);
    }

    function proposeAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Trophy: zero admin");
        pendingAdmin = newAdmin;
        adminProposedAt = block.timestamp;
        emit AdminProposed(newAdmin, block.timestamp);
    }

    function acceptAdmin() external {
        require(pendingAdmin != address(0), "Trophy: no pending admin");
        require(msg.sender == pendingAdmin, "Trophy: not pending admin");
        require(block.timestamp >= adminProposedAt + ADMIN_TIMELOCK, "Trophy: admin timelock");
        address previous = admin;
        admin = pendingAdmin;
        delete pendingAdmin;
        adminProposedAt = 0;
        emit AdminAccepted(previous, admin, block.timestamp);
    }

    function pause() external onlyAdmin {
        _pause();
        emit PauseStateChanged(true);
    }

    function unpause() external onlyAdmin {
        _unpause();
        emit PauseStateChanged(false);
    }

    function mint(
        address to,
        uint256 tokenId,
        Attestation calldata attestation,
        string calldata tokenURI_
    ) external onlyMinter whenNotPaused nonReentrant {
        require(to != address(0), "Trophy: zero address");
        require(bytes(tokenURI_).length > 0, "Trophy: empty uri");
        require(attestation.score <= MAX_SCORE, "Trophy: score bounds");
        require(attestation.fliesCaught <= MAX_FLIES, "Trophy: flies bounds");
        require(attestation.tier <= MAX_TIER, "Trophy: tier bounds");
        require(attestation.seedCommitment != bytes32(0), "Trophy: seed commitment");
        require(attestation.inputLogHash != bytes32(0), "Trophy: input log hash");
        _checkRate();
        _safeMint(to, tokenId);
        attestations[tokenId] = attestation;
        _tokenURIs[tokenId] = tokenURI_;
        emit TrophyMinted(to, tokenId, attestation, tokenURI_);
    }

    function attestationOf(uint256 tokenId) external view returns (Attestation memory) {
        return attestations[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }

    // Soulbound mode blocks transfers; mint (auth == 0) and burn (to == 0) stay allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (soulbound) {
            require(to == address(0) || auth == address(0), "Trophy: soulbound");
        }
        return super._update(to, tokenId, auth);
    }

    function _checkRate() internal {
        uint256 cutoff = block.timestamp > rateWindow ? block.timestamp - rateWindow : 0;
        uint256 count = 0;
        for (uint256 i = _mintTimes.length; i > 0; i--) {
            if (_mintTimes[i - 1] < cutoff) break;
            count++;
        }
        require(count < rateCap, "Trophy: rate cap");
        _mintTimes.push(block.timestamp);
    }
}
