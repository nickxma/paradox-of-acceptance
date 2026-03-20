// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title AcceptancePass
/// @notice Non-transferable ERC-1155 membership credential for paradoxofacceptance.xyz
/// @dev Single token ID (1). One mint per address. Soulbound (non-transferable).
contract AcceptancePass is ERC1155, Ownable, Pausable {
    uint256 public constant MEMBERSHIP_TOKEN_ID = 1;

    string public name = "Acceptance Pass";
    string public symbol = "ACCEPT";

    mapping(address => bool) public hasMinted;
    uint256 public totalMinted;

    error AlreadyMinted();
    error Soulbound();

    constructor(string memory uri_, address owner_) ERC1155(uri_) Ownable(owner_) {}

    /// @notice Mint a membership pass. Free, one per address, gas-sponsored.
    function mint() external whenNotPaused {
        if (hasMinted[msg.sender]) revert AlreadyMinted();
        hasMinted[msg.sender] = true;
        totalMinted++;
        _mint(msg.sender, MEMBERSHIP_TOKEN_ID, 1, "");
    }

    /// @notice Check if an address holds the membership pass.
    function isMember(address account) external view returns (bool) {
        return balanceOf(account, MEMBERSHIP_TOKEN_ID) > 0;
    }

    /// @notice Owner can update the metadata URI.
    function setURI(string memory newuri) external onlyOwner {
        _setURI(newuri);
    }

    /// @notice Owner can pause minting.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Owner can unpause minting.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Override to make tokens soulbound (non-transferable).
    ///      Only minting (from = address(0)) is allowed.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        if (from != address(0) && to != address(0)) revert Soulbound();
        super._update(from, to, ids, values);
    }
}
