// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AcceptancePass.sol";

contract AcceptancePassTest is Test {
    AcceptancePass public pass;
    address public owner = address(0x1);
    address public alice = address(0x2);
    address public bob = address(0x3);

    function setUp() public {
        pass = new AcceptancePass("https://paradoxofacceptance.xyz/api/metadata/{id}.json", owner);
    }

    function test_Metadata() public view {
        assertEq(pass.name(), "Acceptance Pass");
        assertEq(pass.symbol(), "ACCEPT");
        assertEq(pass.MEMBERSHIP_TOKEN_ID(), 1);
    }

    function test_Mint() public {
        vm.prank(alice);
        pass.mint();

        assertEq(pass.balanceOf(alice, 1), 1);
        assertTrue(pass.hasMinted(alice));
        assertTrue(pass.isMember(alice));
        assertEq(pass.totalMinted(), 1);
    }

    function test_MintMultipleUsers() public {
        vm.prank(alice);
        pass.mint();

        vm.prank(bob);
        pass.mint();

        assertEq(pass.totalMinted(), 2);
        assertTrue(pass.isMember(alice));
        assertTrue(pass.isMember(bob));
    }

    function test_RevertDoubleMint() public {
        vm.prank(alice);
        pass.mint();

        vm.prank(alice);
        vm.expectRevert(AcceptancePass.AlreadyMinted.selector);
        pass.mint();
    }

    function test_NonMemberCheck() public view {
        assertFalse(pass.isMember(alice));
        assertFalse(pass.hasMinted(alice));
    }

    function test_Soulbound_RevertTransfer() public {
        vm.prank(alice);
        pass.mint();

        vm.prank(alice);
        vm.expectRevert(AcceptancePass.Soulbound.selector);
        pass.safeTransferFrom(alice, bob, 1, 1, "");
    }

    function test_Soulbound_RevertBatchTransfer() public {
        vm.prank(alice);
        pass.mint();

        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;

        vm.prank(alice);
        vm.expectRevert(AcceptancePass.Soulbound.selector);
        pass.safeBatchTransferFrom(alice, bob, ids, amounts, "");
    }

    function test_Pause() public {
        vm.prank(owner);
        pass.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pass.mint();
    }

    function test_Unpause() public {
        vm.prank(owner);
        pass.pause();

        vm.prank(owner);
        pass.unpause();

        vm.prank(alice);
        pass.mint();
        assertTrue(pass.isMember(alice));
    }

    function test_OnlyOwnerCanPause() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        pass.pause();
    }

    function test_SetURI() public {
        string memory newUri = "https://new-uri.com/{id}.json";
        vm.prank(owner);
        pass.setURI(newUri);
        assertEq(pass.uri(1), newUri);
    }

    function test_OnlyOwnerCanSetURI() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        pass.setURI("https://hacked.com/{id}.json");
    }

    function test_OwnerCorrect() public view {
        assertEq(pass.owner(), owner);
    }
}
