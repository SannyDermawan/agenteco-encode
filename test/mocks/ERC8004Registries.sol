// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/**
 * Test-only stand-ins for the ERC-8004 Identity and Reputation registries
 * (https://eips.ethereum.org/EIPS/eip-8004, Draft), implementing just the parts
 * AgentEco calls, with the interface the EIP specifies. NOT the reference
 * implementation and never deployed anywhere but a local test chain; on real
 * chains AgentEco talks to the registries deployed there.
 */
contract MockIdentityRegistry is ERC721URIStorage {
    uint256 private nextId = 1;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    constructor() ERC721("AgentIdentity", "AGENT") {}

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextId++;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(_isAuthorized(ownerOf(agentId), msg.sender, agentId), "Not owner or operator");
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    /// Owner or approved operator of `agentId` (what the Reputation Registry refuses as a reviewer).
    function isOwnerOrOperator(uint256 agentId, address who) external view returns (bool) {
        return _isAuthorized(ownerOf(agentId), who, agentId);
    }
}

contract MockReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    MockIdentityRegistry private immutable identity;
    mapping(uint256 => mapping(address => Feedback[])) private feedback;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    constructor(MockIdentityRegistry identity_) {
        identity = identity_;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identity);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(valueDecimals <= 18, "valueDecimals > 18");
        // ownerOf reverts for an unregistered agent.
        require(!identity.isOwnerOrOperator(agentId, msg.sender), "Owner cannot give feedback");
        _record(agentId, Feedback(value, valueDecimals, tag1, tag2, false), Links(endpoint, feedbackURI, feedbackHash));
    }

    struct Links {
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    // Split out of giveFeedback only to keep the event's many fields off one stack frame.
    function _record(uint256 agentId, Feedback memory f, Links memory l) private {
        Feedback[] storage list = feedback[agentId][msg.sender];
        list.push(f);
        emit NewFeedback(agentId, msg.sender, uint64(list.length), f.value, f.valueDecimals, f.tag1, f.tag1, f.tag2, l.endpoint, l.feedbackURI, l.feedbackHash);
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(feedback[agentId][clientAddress].length);
    }

    /// feedbackIndex is 1-based, like the index in NewFeedback.
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback storage f = feedback[agentId][clientAddress][feedbackIndex - 1];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }
}
