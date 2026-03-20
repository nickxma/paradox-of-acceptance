// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AcceptancePass.sol";

contract DeployAcceptancePass is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("OWNER_ADDRESS");
        string memory uri = vm.envString("TOKEN_URI");

        vm.startBroadcast(deployerPrivateKey);
        AcceptancePass pass = new AcceptancePass(uri, owner);
        vm.stopBroadcast();

        console.log("AcceptancePass deployed at:", address(pass));
        console.log("Owner:", owner);
    }
}
