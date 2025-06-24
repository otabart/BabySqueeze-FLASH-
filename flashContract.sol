//SPDX-License-Identifier: Go GOCK FOURSEFSFS
pragma solidity ^0.8.24; // It's best practice to use a fixed version, not a range. 0.8.27 is fine.

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

// --- INTERFACES (As Provided) ---
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address owner, address spender, uint256 amount) external; // Note: Balancer expects this to return bool, but we follow your interface
}

interface IROUTER{
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing; 
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of one token for as much as possible of another token
    /// @param params The parameters necessary for the swap, encoded as `ExactInputSingleParams` in calldata
    /// @return amountOut The amount of the received token
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IMTOKEN{
    function mint(uint256 amount) external returns (uint);
    function redeem(uint256 amount) external returns (uint);
    function repayBorrow(uint256 amount) external returns (uint);
    function borrow(uint256 amount) external returns (uint);
    function borrowBalanceStored(address account) external view returns (uint);
    function balanceOf(address owner) external view returns (uint);
}

interface ICOMPTROLLER {
    function enterMarkets(address[] calldata mTokens) external returns (uint[] memory);
}

interface IBALANCER {
      function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external;
}

interface IWETH{
    function deposit() external payable;
}

// Inherits ReentrancyGuard for security
contract lev is ReentrancyGuard {
    // --- STATE VARIABLES (Your Naming) ---
    address public constant BALANCER = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    // NOTE: This is the Uniswap Universal Router. Your IROUTER interface is for a V3-style router.
    address public constant ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address public constant COMPTROLLER = 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C;
    address public constant mWETH = 0x628ff693426583D9a7FB391E54366292F509D457;
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant mUSDC = 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22;
    uint24  public constant USDC_WETH_FEE_TIER = 500; // 0.05% fee for USDC/WETH on Uniswap v3

    address public owner;

    // --- STRUCTS & ENUMS (Your Naming) ---
    enum LoanAction { Open, Close }

    // Using a single struct simplifies encoding/decoding
    struct LoanData {
        LoanAction action;
        uint256 amount; // Represents flashLoanAmount on Open, usdcDebt on Close
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        // Approve protocols to spend this contract's tokens
        IERC20(USDC).approve(mUSDC, type(uint256).max);
        IERC20(WETH).approve(mWETH, type(uint256).max);
        IERC20(WETH).approve(ROUTER, type(uint256).max);
        IERC20(USDC).approve(ROUTER, type(uint256).max);
        EM();
    }

    function EM() internal {
        address[] memory markets = new address[](2);
        markets[0] = mUSDC;
        markets[1] = mWETH;
        ICOMPTROLLER(COMPTROLLER).enterMarkets(markets);
    }

    function openLong() external {
        require(msg.sender == owner || msg.sender == BALANCER);
        uint256 outOfPocket = IERC20(USDC).balanceOf(owner);
        require(outOfPocket > 0, "Owner must have USDC to supply");
        
        uint256 flashLoanAmount = outOfPocket * 3; // Example 3x leverage
        
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = flashLoanAmount;

        bytes memory userData = abi.encode(LoanData({
            action: LoanAction.Open,
            amount: flashLoanAmount
        }));

        IBALANCER(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    function closeLong() external {
        require(msg.sender == owner || msg.sender == BALANCER);
        uint256 usdcDebt = IMTOKEN(mUSDC).borrowBalanceStored(address(this));
        require(usdcDebt > 0, "No debt to close");
        
        address[] memory tokens = new address[](1);
        tokens[0] = USDC;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = usdcDebt;

        bytes memory userData = abi.encode(LoanData({
            action: LoanAction.Close,
            amount: usdcDebt
        }));

        IBALANCER(BALANCER).flashLoan(address(this), tokens, amounts, userData);
    }

    function receiveFlashLoan(
        address[] memory,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external nonReentrant { // Added Reentrancy Guard
        require(msg.sender == BALANCER, "Caller is not Balancer Vault");
        
        LoanData memory params = abi.decode(userData, (LoanData));

        if (params.action == LoanAction.Open) {
            // Pass the flash loan amount AND the fee to the internal function
            _openLongInternal(params.amount, feeAmounts[0]);
        } else if (params.action == LoanAction.Close) {
            // Pass the debt amount AND the fee to the internal function
            _closeLongInternal(params.amount, feeAmounts[0]);
        } else {
            revert("Invalid loan action");
        }
    }

    function _openLongInternal(uint256 flashLoanAmount, uint256 flashLoanFee) internal {
        // 1. Swap all USDC (initial + flash loan) for WETH
        uint256 totalUsdcToSwap = IERC20(USDC).balanceOf(address(this));
        swapOpen(USDC, WETH, totalUsdcToSwap*9999/10000);
       
        uint256 ownerBalance = IERC20(USDC).balanceOf(owner);

        IERC20(USDC).transferFrom(owner, address(this), ownerBalance);

        uint256 firstPayment = ownerBalance;

        IERC20(USDC).transfer(BALANCER, firstPayment);
        // 2. Supply all WETH to Moonwell
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        //uint256 usdcBalance = IERC20(USDC).balanceOf(address(this));

        require(wethBalance > 0, "Swap yielded no WETH");
        require(IMTOKEN(mWETH).mint(wethBalance*9999/10000) == 0, "mWETH mint failed");
        //require(IMTOKEN(mUSDC).mint(usdcBalance*9999/10000) == 0, "mWETH mint failed");

        require(IMTOKEN(mUSDC).borrow(totalUsdcToSwap - firstPayment) == 0, "mUSDC borrow failed");

        IERC20(USDC).transfer(BALANCER, totalUsdcToSwap - firstPayment);

    }

    function _closeLongInternal(uint256 usdcDebt, uint256 flashLoanFee) internal {
    // 1. Repay Moonwell debt with the flash-loaned USDC.
    // We repay the specific debt amount for safety and correctness.
    require(IMTOKEN(mUSDC).repayBorrow(type(uint256).max) == 0, "mUSDC repay failed");

    // 2. Redeem all WETH collateral from Moonwell.
    uint256 mWethBalance = IMTOKEN(mWETH).balanceOf(address(this));
    require(mWethBalance > 0, "No mWETH to redeem");
    require(IMTOKEN(mWETH).redeem(mWethBalance) == 0, "mWETH redeem failed");

    // 3. Perform swaps to get USDC for repayment, with a robust fallback.
    // First, calculate the total amount we need to repay Balancer.
    uint256 balancerRepaymentAmount = usdcDebt + flashLoanFee;

    // We use the "this/catch" pattern to handle potential swap failures.
    
    uint256 allWethLeft = IERC20(WETH).balanceOf(address(this));
     
    swapOpen(WETH, USDC, allWethLeft);
   
    
    uint256 extraUSDC = IERC20(WETH).balanceOf(address(this));
    

    IERC20(USDC).transfer(BALANCER, balancerRepaymentAmount);
    
    IERC20(USDC).transfer(owner, extraUSDC);


    }

    // --- SWAP HELPERS (Your Naming Convention) ---
    function swapOpen(address tokenIn, address tokenOut, uint256 amountIn) public {
        require(msg.sender == owner || msg.sender == BALANCER);
            IROUTER.ExactInputSingleParams memory params =
            IROUTER.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                tickSpacing: 100,
                recipient: address(this), 
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: 0, 
                sqrtPriceLimitX96: 0
            });       
        IROUTER(ROUTER).exactInputSingle(params);
        }
    
    
    function swapClose(address tokenIn, address tokenOut, uint256 amountOut) public {
        require(msg.sender == owner || msg.sender == BALANCER);
        IROUTER.ExactOutputSingleParams memory params =
            IROUTER.ExactOutputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                tickSpacing: 100,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: amountOut,
                amountInMaximum: type(uint256).max,
                sqrtPriceLimitX96: 0
            });
        IROUTER(ROUTER).exactOutputSingle(params);
    }

    function cleanUp() external onlyOwner {
        // Attempt to repay WETH borrow. Continues even if it fails.
        try IMTOKEN(mWETH).repayBorrow(type(uint256).max) {
            // This block is executed on success. Can be left empty.
        } catch {
            // This block is executed on failure. Execution will continue.
        }

        // Attempt to repay USDC borrow. Continues even if it fails.
        try IMTOKEN(mUSDC).repayBorrow(type(uint256).max) {
            // Success
        } catch {
            // Failure
        }

        // Pre-fetch balance to avoid a revert inside the `try` statement itself.
        uint256 mUsdcBalance = IERC20(mUSDC).balanceOf(address(this));
        if (mUsdcBalance > 0) {
            // Attempt to redeem all mUSDC tokens. Continues even if it fails.
            try IMTOKEN(mUSDC).redeem(mUsdcBalance) {
                // Success
            } catch {
                // Failure
            }
        }

        // Pre-fetch balance for the same reason.
        uint256 mWethBalance = IERC20(mWETH).balanceOf(address(this));
        if (mWethBalance > 0) {
            // Attempt to redeem all mWETH tokens. Continues even if it fails.
            try IMTOKEN(mWETH).redeem(mWethBalance) {
                // Success
            } catch {
                // Failure
            }
        }
    }

    fallback() external payable {
        IWETH(WETH).deposit{value: address(this).balance}();
    }

    receive() external payable {
        IWETH(WETH).deposit{value: address(this).balance}();
    }



    // --- UTILITY ---

    function any(address target, bytes calldata data) external onlyOwner {
        address(target).call(data);
    }


    function withdrawAll() external onlyOwner {
        IERC20(WETH).transfer(owner, IERC20(WETH).balanceOf(address(this)));
        IERC20(mWETH).transfer(owner, IMTOKEN(mWETH).balanceOf(address(this)));
        IERC20(USDC).transfer(owner, IERC20(USDC).balanceOf(address(this)));
        IERC20(mUSDC).transfer(owner, IMTOKEN(mUSDC).balanceOf(address(this)));
    }
}