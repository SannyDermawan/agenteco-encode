//! AgentEco escrow program for Solana devnet.
//!
//! Mirrors the state machine of `contracts/AgentEco.sol` (see docs/SOLANA.md for the
//! full design and the one deliberate difference: create+fund are one instruction here).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("3GEEC3dQH1tP2YTZD9Jv915Yj8hcSN6WE8nQZiLJcgHE");

pub const MAX_FEE_BPS: u16 = 1000; // 10%
pub const MAX_WINDOW: i64 = 90 * 24 * 60 * 60; // 90 days

/// Why an escrow was refunded (`EscrowRefunded.reason`).
pub const REFUND_ACCEPT_TIMEOUT: u8 = 0;
pub const REFUND_EXECUTION_TIMEOUT: u8 = 1;
pub const REFUND_DISPUTE_RULING: u8 = 2;
pub const REFUND_DISPUTE_TIMEOUT: u8 = 3;

#[program]
pub mod agenteco_escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        arbiter: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
        min_window: i64,
        accept_timeout: i64,
        dispute_timeout: i64,
        first_escrow_id: u64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        require!(
            min_window > 0 && min_window <= MAX_WINDOW,
            EscrowError::InvalidWindow
        );
        require!(
            accept_timeout >= min_window && accept_timeout <= MAX_WINDOW,
            EscrowError::InvalidWindow
        );
        require!(
            dispute_timeout >= min_window && dispute_timeout <= MAX_WINDOW,
            EscrowError::InvalidWindow
        );
        require!(first_escrow_id > 0, EscrowError::InvalidFirstEscrowId);

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.arbiter = arbiter;
        config.treasury = treasury;
        config.mint = ctx.accounts.mint.key();
        config.fee_bps = fee_bps;
        config.min_window = min_window;
        config.accept_timeout = accept_timeout;
        config.dispute_timeout = dispute_timeout;
        config.next_escrow_id = first_escrow_id;
        config.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Admin only. Escrows that already exist keep the fee rate they were created with.
    pub fn set_fee(ctx: Context<AdminOnly>, fee_bps: u16, treasury: Pubkey) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.fee_bps = fee_bps;
        config.treasury = treasury;
        emit!(FeeUpdated { fee_bps, treasury });
        Ok(())
    }

    /// Admin only: hand dispute rulings to another signer (e.g. a Squads multisig vault).
    pub fn set_arbiter(ctx: Context<AdminOnly>, arbiter: Pubkey) -> Result<()> {
        let previous = ctx.accounts.config.arbiter;
        ctx.accounts.config.arbiter = arbiter;
        emit!(ArbiterUpdated { previous, arbiter });
        Ok(())
    }

    /// Admin only, step 1 of handing the admin role over: nothing changes until `new_admin`
    /// calls `accept_admin`, so a mistyped address can never take the role. Naming the
    /// default (all-zero) address cancels.
    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        emit!(AdminTransferStarted { admin: ctx.accounts.admin.key(), pending_admin: new_admin });
        Ok(())
    }

    /// Step 2: the address named by `transfer_admin` takes the role.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.pending_admin != Pubkey::default() && config.pending_admin == ctx.accounts.new_admin.key(),
            EscrowError::Unauthorized
        );
        let previous = config.admin;
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();
        emit!(AdminUpdated { previous, admin: config.admin });
        Ok(())
    }

    pub fn create_and_fund_escrow(
        ctx: Context<CreateAndFundEscrow>,
        amount: u64,
        execution_window: i64,
        review_window: i64,
        task_hash: [u8; 32],
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(task_hash != [0u8; 32], EscrowError::HashRequired);
        require!(
            ctx.accounts.seller.key() != Pubkey::default(),
            EscrowError::InvalidSeller
        );
        require!(
            execution_window >= config.min_window && execution_window <= MAX_WINDOW,
            EscrowError::InvalidWindow
        );
        require!(
            review_window >= config.min_window && review_window <= MAX_WINDOW,
            EscrowError::InvalidWindow
        );
        require!(
            ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
            EscrowError::BuyerCannotBeSeller
        );

        let now = Clock::get()?.unix_timestamp;
        let id = config.next_escrow_id;
        config.next_escrow_id = config
            .next_escrow_id
            .checked_add(1)
            .ok_or(EscrowError::Overflow)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.id = id;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = ctx.accounts.seller.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.status = EscrowStatus::Funded;
        escrow.fee_bps = config.fee_bps;
        escrow.created_at = now;
        escrow.funded_at = now;
        escrow.execution_window = execution_window;
        escrow.review_window = review_window;
        escrow.accept_deadline = now + config.accept_timeout;
        escrow.task_hash = task_hash;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        ctx.accounts.reputation.seller = ctx.accounts.seller.key();

        emit!(EscrowFunded {
            escrow_id: id,
            buyer: ctx.accounts.buyer.key(),
            seller: ctx.accounts.seller.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            task_hash,
        });

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn start_execution(ctx: Context<StartExecution>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Funded,
            EscrowError::WrongStatus
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= escrow.accept_deadline, EscrowError::WindowPassed);

        escrow.status = EscrowStatus::Executing;
        escrow.executing_at = now;
        escrow.execution_deadline = now + escrow.execution_window;
        emit!(ExecutionStarted { escrow_id: escrow.id, seller: escrow.seller });
        Ok(())
    }

    pub fn claim_accept_timeout(ctx: Context<ClaimAcceptTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let escrow = &ctx.accounts.escrow;
            require!(
                escrow.status == EscrowStatus::Funded,
                EscrowError::WrongStatus
            );
            require!(now > escrow.accept_deadline, EscrowError::WindowNotOver);
        }
        refund_to_buyer(&ctx.accounts.escrow, &ctx.accounts.vault, &ctx.accounts.buyer_token_account, &ctx.accounts.token_program, REFUND_ACCEPT_TIMEOUT)?;
        ctx.accounts.escrow.status = EscrowStatus::Refunded;
        Ok(())
    }

    pub fn mark_delivered(ctx: Context<MarkDelivered>, result_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Executing,
            EscrowError::WrongStatus
        );
        let now = Clock::get()?.unix_timestamp;
        escrow.status = EscrowStatus::Delivered;
        escrow.delivered_at = now;
        escrow.review_deadline = now + escrow.review_window;
        escrow.result_hash = result_hash;
        emit!(ResultDelivered { escrow_id: escrow.id, seller: escrow.seller, result_hash });
        Ok(())
    }

    pub fn claim_execution_timeout(ctx: Context<ClaimExecutionTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let escrow = &ctx.accounts.escrow;
            require!(
                escrow.status == EscrowStatus::Executing,
                EscrowError::WrongStatus
            );
            require!(now > escrow.execution_deadline, EscrowError::WindowNotOver);
        }
        refund_to_buyer(&ctx.accounts.escrow, &ctx.accounts.vault, &ctx.accounts.buyer_token_account, &ctx.accounts.token_program, REFUND_EXECUTION_TIMEOUT)?;
        ctx.accounts.escrow.status = EscrowStatus::Refunded;
        ctx.accounts.reputation.failed_jobs += 1;
        Ok(())
    }

    pub fn accept_and_settle(ctx: Context<AcceptAndSettle>) -> Result<()> {
        require!(
            ctx.accounts.escrow.status == EscrowStatus::Delivered,
            EscrowError::WrongStatus
        );
        settle(&mut ctx.accounts.escrow, &mut ctx.accounts.reputation, &ctx.accounts.vault, &ctx.accounts.seller_token_account, &ctx.accounts.treasury_token_account, &ctx.accounts.token_program)
    }

    pub fn finalize_after_review_window(ctx: Context<FinalizeAfterReviewWindow>) -> Result<()> {
        {
            let escrow = &ctx.accounts.escrow;
            require!(
                escrow.status == EscrowStatus::Delivered,
                EscrowError::WrongStatus
            );
            let now = Clock::get()?.unix_timestamp;
            require!(now > escrow.review_deadline, EscrowError::WindowNotOver);
        }
        settle(&mut ctx.accounts.escrow, &mut ctx.accounts.reputation, &ctx.accounts.vault, &ctx.accounts.seller_token_account, &ctx.accounts.treasury_token_account, &ctx.accounts.token_program)
    }

    pub fn raise_dispute(ctx: Context<RaiseDispute>, reason_hash: [u8; 32]) -> Result<()> {
        require!(reason_hash != [0u8; 32], EscrowError::HashRequired);
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Delivered,
            EscrowError::WrongStatus
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= escrow.review_deadline, EscrowError::WindowPassed);

        escrow.status = EscrowStatus::Disputed;
        escrow.dispute_reason_hash = reason_hash;
        escrow.disputed_at = now;
        escrow.dispute_deadline = now + ctx.accounts.config.dispute_timeout;
        emit!(DisputeRaised { escrow_id: escrow.id, buyer: escrow.buyer, reason_hash });
        Ok(())
    }

    pub fn submit_dispute_response(
        ctx: Context<SubmitDisputeResponse>,
        response_hash: [u8; 32],
    ) -> Result<()> {
        require!(response_hash != [0u8; 32], EscrowError::HashRequired);
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Disputed,
            EscrowError::WrongStatus
        );
        let now = Clock::get()?.unix_timestamp;
        require!(now <= escrow.dispute_deadline, EscrowError::WindowPassed);
        require!(
            escrow.dispute_response_hash == [0u8; 32],
            EscrowError::AlreadyResponded
        );
        escrow.dispute_response_hash = response_hash;
        emit!(DisputeResponseSubmitted { escrow_id: escrow.id, seller: escrow.seller, response_hash });
        Ok(())
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        to_seller: bool,
        rationale_hash: [u8; 32],
    ) -> Result<()> {
        require!(rationale_hash != [0u8; 32], EscrowError::HashRequired);
        {
            let escrow = &ctx.accounts.escrow;
            require!(
                escrow.status == EscrowStatus::Disputed,
                EscrowError::WrongStatus
            );
            let now = Clock::get()?.unix_timestamp;
            require!(now <= escrow.dispute_deadline, EscrowError::WindowPassed);
        }
        let expected_owner = if to_seller {
            ctx.accounts.escrow.seller
        } else {
            ctx.accounts.escrow.buyer
        };
        require!(
            ctx.accounts.seller_or_buyer_token_account.owner == expected_owner
                && ctx.accounts.seller_or_buyer_token_account.mint == ctx.accounts.escrow.mint,
            EscrowError::Unauthorized
        );
        ctx.accounts.escrow.resolution_hash = rationale_hash;
        emit!(DisputeResolved {
            escrow_id: ctx.accounts.escrow.id,
            arbiter: ctx.accounts.arbiter.key(),
            to_seller,
            rationale_hash,
        });

        if to_seller {
            settle(&mut ctx.accounts.escrow, &mut ctx.accounts.reputation, &ctx.accounts.vault, &ctx.accounts.seller_or_buyer_token_account, &ctx.accounts.treasury_token_account, &ctx.accounts.token_program)
        } else {
            refund_to_buyer(&ctx.accounts.escrow, &ctx.accounts.vault, &ctx.accounts.seller_or_buyer_token_account, &ctx.accounts.token_program, REFUND_DISPUTE_RULING)?;
            ctx.accounts.escrow.status = EscrowStatus::Refunded;
            ctx.accounts.reputation.failed_jobs += 1;
            Ok(())
        }
    }

    pub fn claim_dispute_timeout(ctx: Context<ClaimDisputeTimeout>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let escrow = &ctx.accounts.escrow;
            require!(
                escrow.status == EscrowStatus::Disputed,
                EscrowError::WrongStatus
            );
            require!(now > escrow.dispute_deadline, EscrowError::WindowNotOver);
        }
        refund_to_buyer(&ctx.accounts.escrow, &ctx.accounts.vault, &ctx.accounts.buyer_token_account, &ctx.accounts.token_program, REFUND_DISPUTE_TIMEOUT)?;
        ctx.accounts.escrow.status = EscrowStatus::Refunded;
        // Nobody was found at fault: no reputation effect, mirroring the EVM contract.
        Ok(())
    }

    pub fn rate_seller(ctx: Context<RateSeller>, score: u8) -> Result<()> {
        require!(score >= 1 && score <= 100, EscrowError::InvalidScore);
        let escrow = &mut ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Settled || escrow.status == EscrowStatus::Refunded,
            EscrowError::WrongStatus
        );
        require!(escrow.delivered_at != 0, EscrowError::NothingDelivered);
        require!(!escrow.rated, EscrowError::AlreadyRated);

        escrow.rated = true;
        let rep = &mut ctx.accounts.reputation;
        rep.rating_sum += score as u64;
        rep.rating_count += 1;
        emit!(SellerRated { escrow_id: escrow.id, seller: escrow.seller, buyer: escrow.buyer, score });
        Ok(())
    }
}

/// Pays the platform fee to the treasury and the remainder to the seller, from the vault.
fn settle<'info>(
    escrow: &mut Account<'info, Escrow>,
    reputation: &mut Account<'info, Reputation>,
    vault: &Account<'info, TokenAccount>,
    seller_token_account: &Account<'info, TokenAccount>,
    treasury_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    escrow.status = EscrowStatus::Settled;
    escrow.settled_at = now;

    reputation.completed_jobs += 1;
    reputation.total_volume_settled += escrow.amount;

    let fee = (escrow.amount as u128 * escrow.fee_bps as u128 / 10_000u128) as u64;
    let to_seller = escrow.amount - fee;
    emit!(EscrowSettled {
        escrow_id: escrow.id,
        buyer: escrow.buyer,
        seller: escrow.seller,
        amount: escrow.amount,
        fee,
    });

    let escrow_id_bytes = escrow.id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"vault", escrow_id_bytes.as_ref(), &[escrow.vault_bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer {
                    from: vault.to_account_info(),
                    to: treasury_token_account.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
        )?;
    }

    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to: seller_token_account.to_account_info(),
                authority: vault.to_account_info(),
            },
            signer_seeds,
        ),
        to_seller,
    )?;

    Ok(())
}

fn refund_to_buyer<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    buyer_token_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    reason: u8,
) -> Result<()> {
    emit!(EscrowRefunded {
        escrow_id: escrow.id,
        buyer: escrow.buyer,
        amount: escrow.amount,
        reason,
    });
    let escrow_id_bytes = escrow.id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"vault", escrow_id_bytes.as_ref(), &[escrow.vault_bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            token_program.key(),
            Transfer {
                from: vault.to_account_info(),
                to: buyer_token_account.to_account_info(),
                authority: vault.to_account_info(),
            },
            signer_seeds,
        ),
        escrow.amount,
    )
}

// =================================================================
// ACCOUNTS
// =================================================================

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub arbiter: Pubkey,
    pub treasury: Pubkey,
    /// The one settlement token of this deployment (like `USDT immutable` in AgentEco.sol).
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub min_window: i64,
    pub accept_timeout: i64,
    pub dispute_timeout: i64,
    pub next_escrow_id: u64,
    /// Named by `transfer_admin`, empty until then; kept last so earlier offsets never move.
    pub pending_admin: Pubkey,
}

impl Config {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 2 + 8 + 8 + 8 + 8 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Funded,
    Executing,
    Delivered,
    Disputed,
    Settled,
    Refunded,
}

#[account]
pub struct Escrow {
    pub id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub status: EscrowStatus,
    pub fee_bps: u16,

    pub created_at: i64,
    pub funded_at: i64,
    pub executing_at: i64,
    pub delivered_at: i64,
    pub settled_at: i64,

    pub execution_window: i64,
    pub review_window: i64,
    pub execution_deadline: i64,
    pub review_deadline: i64,
    pub accept_deadline: i64,

    pub disputed_at: i64,
    pub dispute_deadline: i64,

    pub task_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub dispute_reason_hash: [u8; 32],
    pub dispute_response_hash: [u8; 32],
    pub resolution_hash: [u8; 32],

    pub rated: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Escrow {
    pub const SIZE: usize = 8
        + 8 + 32 + 32 + 32 + 8 + 1 + 2
        + 8 * 5
        + 8 * 5
        + 8 * 2
        + 32 * 5
        + 1 + 1 + 1;
}

#[account]
#[derive(Default)]
pub struct Reputation {
    pub seller: Pubkey,
    pub completed_jobs: u64,
    pub failed_jobs: u64,
    pub total_volume_settled: u64,
    pub rating_sum: u64,
    pub rating_count: u64,
}

impl Reputation {
    pub const SIZE: usize = 8 + 32 + 8 * 5;
}

// =================================================================
// CONTEXTS
// =================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = Config::SIZE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = admin.key() == config.admin @ EscrowError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct CreateAndFundEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: only used as the escrow's recorded counterparty; never read or written here.
    pub seller: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = buyer,
        space = Escrow::SIZE,
        seeds = [b"escrow", config.next_escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(constraint = mint.key() == config.mint @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = buyer,
        token::mint = mint,
        token::authority = vault,
        seeds = [b"vault", config.next_escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = buyer_token_account.mint == mint.key() @ EscrowError::WrongMint)]
    pub buyer_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = Reputation::SIZE,
        seeds = [b"reputation", seller.key().as_ref()],
        bump
    )]
    pub reputation: Account<'info, Reputation>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct StartExecution<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct ClaimAcceptTimeout<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.id.to_le_bytes().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = buyer_token_account.owner == escrow.buyer && buyer_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub buyer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MarkDelivered<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct ClaimExecutionTimeout<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.id.to_le_bytes().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = buyer_token_account.owner == escrow.buyer && buyer_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub buyer_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"reputation", escrow.seller.as_ref()], bump)]
    pub reputation: Account<'info, Reputation>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AcceptAndSettle<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = buyer @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.id.to_le_bytes().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = seller_token_account.owner == escrow.seller && seller_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub seller_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = treasury_token_account.owner == config.treasury && treasury_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"reputation", escrow.seller.as_ref()], bump)]
    pub reputation: Account<'info, Reputation>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeAfterReviewWindow<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.id.to_le_bytes().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = seller_token_account.owner == escrow.seller && seller_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub seller_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = treasury_token_account.owner == config.treasury && treasury_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"reputation", escrow.seller.as_ref()], bump)]
    pub reputation: Account<'info, Reputation>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SubmitDisputeResponse<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(constraint = arbiter.key() == config.arbiter @ EscrowError::Unauthorized)]
    pub arbiter: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.id.to_le_bytes().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    /// The seller's token account when `to_seller`, the buyer's otherwise; the
    /// instruction checks its owner and mint against the escrow for the chosen branch.
    #[account(mut)]
    pub seller_or_buyer_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = treasury_token_account.owner == config.treasury && treasury_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"reputation", escrow.seller.as_ref()], bump)]
    pub reputation: Account<'info, Reputation>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimDisputeTimeout<'info> {
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"vault", escrow.id.to_le_bytes().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = buyer_token_account.owner == escrow.buyer && buyer_token_account.mint == escrow.mint @ EscrowError::Unauthorized)]
    pub buyer_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RateSeller<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [b"reputation", escrow.seller.as_ref()], bump)]
    pub reputation: Account<'info, Reputation>,
}

// =================================================================
// EVENTS (the Solana counterpart of AgentEco.sol's events; decoded by SolanaAdapter and
// usable by a keeper or an indexer)
// =================================================================

#[event]
pub struct EscrowFunded {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub task_hash: [u8; 32],
}

#[event]
pub struct ExecutionStarted {
    pub escrow_id: u64,
    pub seller: Pubkey,
}

#[event]
pub struct ResultDelivered {
    pub escrow_id: u64,
    pub seller: Pubkey,
    pub result_hash: [u8; 32],
}

/// `amount` is the full price; the seller received `amount - fee`.
#[event]
pub struct EscrowSettled {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

/// `reason`: the `REFUND_*` constants.
#[event]
pub struct EscrowRefunded {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub amount: u64,
    pub reason: u8,
}

#[event]
pub struct DisputeRaised {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub reason_hash: [u8; 32],
}

#[event]
pub struct DisputeResponseSubmitted {
    pub escrow_id: u64,
    pub seller: Pubkey,
    pub response_hash: [u8; 32],
}

#[event]
pub struct DisputeResolved {
    pub escrow_id: u64,
    pub arbiter: Pubkey,
    pub to_seller: bool,
    pub rationale_hash: [u8; 32],
}

#[event]
pub struct SellerRated {
    pub escrow_id: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub score: u8,
}

#[event]
pub struct FeeUpdated {
    pub fee_bps: u16,
    pub treasury: Pubkey,
}

#[event]
pub struct ArbiterUpdated {
    pub previous: Pubkey,
    pub arbiter: Pubkey,
}

#[event]
pub struct AdminTransferStarted {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminUpdated {
    pub previous: Pubkey,
    pub admin: Pubkey,
}

// =================================================================
// ERRORS
// =================================================================

#[error_code]
pub enum EscrowError {
    #[msg("fee exceeds the maximum")]
    FeeTooHigh,
    #[msg("window out of bounds")]
    InvalidWindow,
    #[msg("first escrow id must be > 0")]
    InvalidFirstEscrowId,
    #[msg("amount must be greater than zero")]
    InvalidAmount,
    #[msg("buyer cannot be seller")]
    BuyerCannotBeSeller,
    #[msg("escrow id overflow")]
    Overflow,
    #[msg("escrow is not in the required status")]
    WrongStatus,
    #[msg("the deadline for this action has already passed")]
    WindowPassed,
    #[msg("the deadline for this action has not passed yet")]
    WindowNotOver,
    #[msg("a dispute response was already submitted")]
    AlreadyResponded,
    #[msg("score must be between 1 and 100")]
    InvalidScore,
    #[msg("nothing was ever delivered on this escrow")]
    NothingDelivered,
    #[msg("this escrow was already rated")]
    AlreadyRated,
    #[msg("not authorized")]
    Unauthorized,
    #[msg("token account mint does not match the escrow's mint")]
    WrongMint,
    #[msg("a non-zero hash is required")]
    HashRequired,
    #[msg("invalid seller")]
    InvalidSeller,
}
