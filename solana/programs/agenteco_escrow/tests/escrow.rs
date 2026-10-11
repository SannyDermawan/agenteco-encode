//! Full state-machine tests for the agenteco_escrow program, run against litesvm.
//!
//! Built and run with (see docs/SOLANA.md §1 for why `--arch v0` matters):
//!   cargo build-sbf --arch v0
//!   cargo test
//!
//! Instructions are built by hand (Anchor sighash discriminator + manually packed,
//! borsh-compatible little-endian args) rather than through the program crate's
//! generated client types, so this test crate never has to depend on the program
//! crate itself (which would otherwise fight over the `no-entrypoint` feature with
//! the `cargo build-sbf` build of the same crate).

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    sysvar::rent::Rent,
    transaction::Transaction,
};

mod system_program {
    use solana_sdk::pubkey::Pubkey;
    pub fn id() -> Pubkey {
        solana_sdk::pubkey!("11111111111111111111111111111111111111111")
    }
}
use spl_token::state::{Account as TokenAccountState, AccountState, Mint as MintState};
use spl_token::solana_program::program_pack::Pack;

// The program's own `declare_id!`, so a different program keypair needs no change here.
fn program_id() -> Pubkey {
    Pubkey::new_from_array(agenteco_escrow::ID.to_bytes())
}

fn program_so_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/deploy/agenteco_escrow.so")
}

fn spl_token_so_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/spl_token.so")
}

fn sighash(name: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("global:{name}").as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash[..8]);
    out
}

fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config"], &program_id())
}

fn escrow_pda(id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"escrow", &id.to_le_bytes()], &program_id())
}

fn vault_pda(id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", &id.to_le_bytes()], &program_id())
}

fn reputation_pda(seller: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"reputation", seller.as_ref()], &program_id())
}

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    buyer: Keypair,
    seller: Keypair,
    arbiter: Keypair,
    mint: Pubkey,
    treasury_ata: Pubkey,
    buyer_ata: Pubkey,
    seller_ata: Pubkey,
    config: Pubkey,
    first_escrow_id: u64,
}

const DECIMALS: u8 = 6;
const BUYER_START_BALANCE: u64 = 1_000_000_000; // 1,000 tokens at 6dp

fn mint_bytes(mint_authority: Pubkey) -> Vec<u8> {
    let mint = MintState {
        mint_authority: spl_token::solana_program::program_option::COption::Some(mint_authority),
        supply: u64::MAX / 2,
        decimals: DECIMALS,
        is_initialized: true,
        freeze_authority: spl_token::solana_program::program_option::COption::None,
    };
    let mut buf = vec![0u8; MintState::LEN];
    mint.pack_into_slice(&mut buf);
    buf
}

fn token_account_bytes(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let acc = TokenAccountState {
        mint,
        owner,
        amount,
        delegate: spl_token::solana_program::program_option::COption::None,
        state: AccountState::Initialized,
        is_native: spl_token::solana_program::program_option::COption::None,
        delegated_amount: 0,
        close_authority: spl_token::solana_program::program_option::COption::None,
    };
    let mut buf = vec![0u8; TokenAccountState::LEN];
    acc.pack_into_slice(&mut buf);
    buf
}

fn set_token_account(svm: &mut LiteSVM, pubkey: Pubkey, data: Vec<u8>) {
    let rent = svm.get_sysvar::<Rent>().minimum_balance(data.len());
    svm.set_account(
        pubkey,
        Account {
            lamports: rent,
            data,
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// Sets up a fresh svm with the program + real SPL Token program loaded, a devnet-shaped
/// mint, funded buyer/seller/treasury token accounts, and an initialized `Config` with
/// very short windows (so timeout paths can be exercised without warping far).
fn setup(accept_timeout: i64, execution_window_min: i64, dispute_timeout: i64) -> Fixture {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), program_so_path())
        .expect("load agenteco_escrow.so (did you run `cargo build-sbf --arch v0`?)");
    svm.add_program_from_file(spl_token::id(), spl_token_so_path())
        .expect("load test-fixtures/spl_token.so");

    // litesvm's default Clock starts at unix_timestamp = 0; every real cluster's never
    // does, and the program treats "timestamp == 0" as "this stage never happened" (the
    // same sentinel contracts/AgentEco.sol uses), so tests need a realistic starting time.
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 1_700_000_000;
    svm.set_sysvar(&clock);

    let admin = Keypair::new();
    let buyer = Keypair::new();
    let seller = Keypair::new();
    let arbiter = Keypair::new();
    let treasury = Keypair::new();

    for kp in [&admin, &buyer, &seller, &arbiter, &treasury] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }

    let mint = Pubkey::new_unique();
    set_token_account(&mut svm, mint, mint_bytes(admin.pubkey()));

    let buyer_ata = Pubkey::new_unique();
    set_token_account(
        &mut svm,
        buyer_ata,
        token_account_bytes(mint, buyer.pubkey(), BUYER_START_BALANCE),
    );
    let seller_ata = Pubkey::new_unique();
    set_token_account(&mut svm, seller_ata, token_account_bytes(mint, seller.pubkey(), 0));
    let treasury_ata = Pubkey::new_unique();
    set_token_account(
        &mut svm,
        treasury_ata,
        token_account_bytes(mint, treasury.pubkey(), 0),
    );

    let (config, _) = config_pda();
    let mut data = sighash("initialize").to_vec();
    data.extend_from_slice(arbiter.pubkey().as_ref());
    data.extend_from_slice(treasury.pubkey().as_ref());
    data.extend_from_slice(&250u16.to_le_bytes()); // 2.5%
    data.extend_from_slice(&execution_window_min.to_le_bytes()); // min_window
    data.extend_from_slice(&accept_timeout.to_le_bytes());
    data.extend_from_slice(&dispute_timeout.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes()); // first_escrow_id

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    };
    send(&mut svm, &[ix], &admin, &[&admin]).expect("initialize");

    Fixture {
        svm,
        admin,
        buyer,
        seller,
        arbiter,
        mint,
        treasury_ata,
        buyer_ata,
        seller_ata,
        config,
        first_escrow_id: 1,
    }
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), String> {
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        signers,
        svm.latest_blockhash(),
    );
    let result = svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"));
    // A retry of the same instruction must be a different transaction, or litesvm rejects
    // it as AlreadyProcessed and a "must fail" test would pass without ever reaching the
    // program's own checks.
    svm.expire_blockhash();
    result
}

fn create_and_fund(
    fx: &mut Fixture,
    amount: u64,
    execution_window: i64,
    review_window: i64,
    task_hash: [u8; 32],
) -> (u64, Pubkey, Pubkey) {
    let id = fx.first_escrow_id;
    let (escrow, _) = escrow_pda(id);
    let (vault, _) = vault_pda(id);
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());

    let mut data = sighash("create_and_fund_escrow").to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&execution_window.to_le_bytes());
    data.extend_from_slice(&review_window.to_le_bytes());
    data.extend_from_slice(&task_hash);

    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fx.buyer.pubkey(), true),
            AccountMeta::new_readonly(fx.seller.pubkey(), false),
            AccountMeta::new(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.buyer_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::id(), false),
        ],
        data,
    };
    let buyer = fx.buyer.insecure_clone();
    send(&mut fx.svm, &[ix], &buyer, &[&buyer]).expect("create_and_fund_escrow");
    (id, escrow, vault)
}

fn start_execution(fx: &mut Fixture, escrow: Pubkey) {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.seller.pubkey(), true),
            AccountMeta::new(escrow, false),
        ],
        data: sighash("start_execution").to_vec(),
    };
    let seller = fx.seller.insecure_clone();
    send(&mut fx.svm, &[ix], &seller, &[&seller]).expect("start_execution");
}

fn mark_delivered(fx: &mut Fixture, escrow: Pubkey, result_hash: [u8; 32]) {
    let mut data = sighash("mark_delivered").to_vec();
    data.extend_from_slice(&result_hash);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.seller.pubkey(), true),
            AccountMeta::new(escrow, false),
        ],
        data,
    };
    let seller = fx.seller.insecure_clone();
    send(&mut fx.svm, &[ix], &seller, &[&seller]).expect("mark_delivered");
}

fn accept_and_settle(fx: &mut Fixture, escrow: Pubkey, vault: Pubkey) -> Result<(), String> {
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.buyer.pubkey(), true),
            AccountMeta::new_readonly(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.seller_ata, false),
            AccountMeta::new(fx.treasury_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: sighash("accept_and_settle").to_vec(),
    };
    let buyer = fx.buyer.insecure_clone();
    send(&mut fx.svm, &[ix], &buyer, &[&buyer])
}

fn finalize_after_review_window(fx: &mut Fixture, escrow: Pubkey, vault: Pubkey) -> Result<(), String> {
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let keeper = fx.admin.insecure_clone(); // "anyone"
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(keeper.pubkey(), true),
            AccountMeta::new_readonly(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.seller_ata, false),
            AccountMeta::new(fx.treasury_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: sighash("finalize_after_review_window").to_vec(),
    };
    send(&mut fx.svm, &[ix], &keeper, &[&keeper])
}

fn raise_dispute(fx: &mut Fixture, escrow: Pubkey, reason_hash: [u8; 32]) -> Result<(), String> {
    let mut data = sighash("raise_dispute").to_vec();
    data.extend_from_slice(&reason_hash);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.buyer.pubkey(), true),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(fx.config, false),
        ],
        data,
    };
    let buyer = fx.buyer.insecure_clone();
    send(&mut fx.svm, &[ix], &buyer, &[&buyer])
}

fn submit_dispute_response(fx: &mut Fixture, escrow: Pubkey, response_hash: [u8; 32]) -> Result<(), String> {
    let mut data = sighash("submit_dispute_response").to_vec();
    data.extend_from_slice(&response_hash);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.seller.pubkey(), true),
            AccountMeta::new(escrow, false),
        ],
        data,
    };
    let seller = fx.seller.insecure_clone();
    send(&mut fx.svm, &[ix], &seller, &[&seller])
}

fn resolve_dispute(
    fx: &mut Fixture,
    escrow: Pubkey,
    vault: Pubkey,
    to_seller: bool,
    rationale_hash: [u8; 32],
) -> Result<(), String> {
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let payout_ata = if to_seller { fx.seller_ata } else { fx.buyer_ata };
    let mut data = sighash("resolve_dispute").to_vec();
    data.push(if to_seller { 1 } else { 0 });
    data.extend_from_slice(&rationale_hash);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.arbiter.pubkey(), true),
            AccountMeta::new_readonly(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(payout_ata, false),
            AccountMeta::new(fx.treasury_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data,
    };
    let arbiter = fx.arbiter.insecure_clone();
    send(&mut fx.svm, &[ix], &arbiter, &[&arbiter])
}

fn claim_accept_timeout(fx: &mut Fixture, escrow: Pubkey, vault: Pubkey) -> Result<(), String> {
    let keeper = fx.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.buyer_ata, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: sighash("claim_accept_timeout").to_vec(),
    };
    send(&mut fx.svm, &[ix], &keeper, &[&keeper])
}

fn claim_execution_timeout(fx: &mut Fixture, escrow: Pubkey, vault: Pubkey) -> Result<(), String> {
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let keeper = fx.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.buyer_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: sighash("claim_execution_timeout").to_vec(),
    };
    send(&mut fx.svm, &[ix], &keeper, &[&keeper])
}

fn claim_dispute_timeout(fx: &mut Fixture, escrow: Pubkey, vault: Pubkey) -> Result<(), String> {
    let keeper = fx.admin.insecure_clone();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.buyer_ata, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: sighash("claim_dispute_timeout").to_vec(),
    };
    send(&mut fx.svm, &[ix], &keeper, &[&keeper])
}

fn rate_seller(fx: &mut Fixture, escrow: Pubkey, score: u8) -> Result<(), String> {
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let mut data = sighash("rate_seller").to_vec();
    data.push(score);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.buyer.pubkey(), true),
            AccountMeta::new(escrow, false),
            AccountMeta::new(reputation, false),
        ],
        data,
    };
    let buyer = fx.buyer.insecure_clone();
    send(&mut fx.svm, &[ix], &buyer, &[&buyer])
}

/// (completed_jobs, failed_jobs, total_volume_settled, rating_sum, rating_count)
fn reputation_of(svm: &LiteSVM, seller: &Pubkey) -> (u64, u64, u64, u64, u64) {
    let (pda, _) = reputation_pda(seller);
    let acc = svm.get_account(&pda).expect("reputation account");
    let d = &acc.data[8 + 32..]; // discriminator + seller pubkey
    let n = |i: usize| u64::from_le_bytes(d[i * 8..i * 8 + 8].try_into().unwrap());
    (n(0), n(1), n(2), n(3), n(4))
}

fn admin_ix(fx: &mut Fixture, signer: &Keypair, name: &str, args: &[u8]) -> Result<(), String> {
    let mut data = sighash(name).to_vec();
    data.extend_from_slice(args);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(fx.config, false),
        ],
        data,
    };
    let signer = signer.insecure_clone();
    send(&mut fx.svm, &[ix], &signer, &[&signer])
}

/// Asserts the transaction failed with exactly this Anchor custom error number
/// (6000 + the variant's index in `EscrowError`), so a test cannot pass for the wrong reason.
fn fails_with(result: Result<(), String>, code: u32) {
    match result {
        Ok(()) => panic!("expected error {code}, but the transaction succeeded"),
        Err(e) => assert!(
            e.contains(&format!("Custom({code})")),
            "expected custom error {code}, got: {e}"
        ),
    }
}

fn token_balance(svm: &LiteSVM, ata: Pubkey) -> u64 {
    let acc = svm.get_account(&ata).expect("account exists");
    TokenAccountState::unpack(&acc.data).unwrap().amount
}

fn warp_seconds(svm: &mut LiteSVM, delta: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp += delta;
    svm.set_sysvar(&clock);
    // A retried instruction after warping would otherwise be byte-for-byte identical to
    // the earlier (deliberately failing) attempt and get rejected as a duplicate signature.
    svm.expire_blockhash();
}

const TASK_HASH: [u8; 32] = [7u8; 32];
const RESULT_HASH: [u8; 32] = [8u8; 32];
const REASON_HASH: [u8; 32] = [9u8; 32];
const RESPONSE_HASH: [u8; 32] = [10u8; 32];
const RATIONALE_HASH: [u8; 32] = [11u8; 32];

const AMOUNT: u64 = 100_000_000; // 100 tokens at 6dp
const FEE: u64 = AMOUNT * 250 / 10_000; // 2.5%

#[test]
fn happy_path_settle_charges_fee_only_on_settle() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);

    assert_eq!(token_balance(&fx.svm, fx.buyer_ata), BUYER_START_BALANCE - AMOUNT);
    assert_eq!(token_balance(&fx.svm, vault), AMOUNT);

    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    accept_and_settle(&mut fx, escrow, vault).expect("settle");

    assert_eq!(token_balance(&fx.svm, fx.seller_ata), AMOUNT - FEE);
    assert_eq!(token_balance(&fx.svm, fx.treasury_ata), FEE);
    assert_eq!(token_balance(&fx.svm, vault), 0);
    assert_eq!(reputation_of(&fx.svm, &fx.seller.pubkey()), (1, 0, AMOUNT, 0, 0));

    // Rating works once the escrow is final and something was delivered.
    rate_seller(&mut fx, escrow, 90).expect("rate");
    assert_eq!(reputation_of(&fx.svm, &fx.seller.pubkey()), (1, 0, AMOUNT, 90, 1));
    fails_with(rate_seller(&mut fx, escrow, 90), 6012);
}

#[test]
fn finalize_after_review_window_pays_out_like_accept() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 5, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);

    fails_with(finalize_after_review_window(&mut fx, escrow, vault), 6008);

    warp_seconds(&mut fx.svm, 10);
    finalize_after_review_window(&mut fx, escrow, vault).expect("finalize");
    assert_eq!(token_balance(&fx.svm, fx.seller_ata), AMOUNT - FEE);
    assert_eq!(token_balance(&fx.svm, fx.treasury_ata), FEE);
}

#[test]
fn claim_accept_timeout_refunds_buyer_with_no_fee() {
    let mut fx = setup(5, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);

    fails_with(claim_accept_timeout(&mut fx, escrow, vault), 6008);

    warp_seconds(&mut fx.svm, 10);
    claim_accept_timeout(&mut fx, escrow, vault).expect("claim accept timeout");
    assert_eq!(token_balance(&fx.svm, fx.buyer_ata), BUYER_START_BALANCE);
    assert_eq!(token_balance(&fx.svm, vault), 0);

    fails_with(start_execution_result(&mut fx, escrow), 6006);
}

fn start_execution_result(fx: &mut Fixture, escrow: Pubkey) -> Result<(), String> {
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.seller.pubkey(), true),
            AccountMeta::new(escrow, false),
        ],
        data: sighash("start_execution").to_vec(),
    };
    let seller = fx.seller.insecure_clone();
    send(&mut fx.svm, &[ix], &seller, &[&seller])
}

#[test]
fn claim_execution_timeout_refunds_buyer_and_counts_as_failure() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 5, 60, TASK_HASH);
    start_execution(&mut fx, escrow);

    fails_with(claim_execution_timeout(&mut fx, escrow, vault), 6008);

    warp_seconds(&mut fx.svm, 10);
    claim_execution_timeout(&mut fx, escrow, vault).expect("claim execution timeout");
    assert_eq!(token_balance(&fx.svm, fx.buyer_ata), BUYER_START_BALANCE);
    assert_eq!(token_balance(&fx.svm, fx.treasury_ata), 0, "a refund carries no fee");
    assert_eq!(reputation_of(&fx.svm, &fx.seller.pubkey()), (0, 1, 0, 0, 0));

    // Nothing was ever delivered, so rating is refused even though the escrow is final.
    fails_with(rate_seller(&mut fx, escrow, 50), 6011);
}

#[test]
fn dispute_resolved_for_seller_pays_seller_with_fee() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    raise_dispute(&mut fx, escrow, REASON_HASH).expect("raise dispute");
    submit_dispute_response(&mut fx, escrow, RESPONSE_HASH).expect("respond");

    resolve_dispute(&mut fx, escrow, vault, true, RATIONALE_HASH).expect("resolve for seller");
    assert_eq!(token_balance(&fx.svm, fx.seller_ata), AMOUNT - FEE);
    assert_eq!(token_balance(&fx.svm, fx.treasury_ata), FEE);
    assert_eq!(reputation_of(&fx.svm, &fx.seller.pubkey()), (1, 0, AMOUNT, 0, 0));
}

#[test]
fn dispute_resolved_for_buyer_refunds_with_no_fee_and_counts_as_failure() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    raise_dispute(&mut fx, escrow, REASON_HASH).expect("raise dispute");

    resolve_dispute(&mut fx, escrow, vault, false, RATIONALE_HASH).expect("resolve for buyer");
    assert_eq!(token_balance(&fx.svm, fx.buyer_ata), BUYER_START_BALANCE);
    assert_eq!(token_balance(&fx.svm, fx.treasury_ata), 0);
    assert_eq!(reputation_of(&fx.svm, &fx.seller.pubkey()), (0, 1, 0, 0, 0));

    // Something was delivered before the dispute, so rating is allowed on this refund.
    rate_seller(&mut fx, escrow, 10).expect("rate after buyer-favor dispute");
}

#[test]
fn claim_dispute_timeout_refunds_with_no_reputation_effect() {
    let mut fx = setup(60, 1, 5);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    raise_dispute(&mut fx, escrow, REASON_HASH).expect("raise dispute");

    fails_with(claim_dispute_timeout(&mut fx, escrow, vault), 6008);

    warp_seconds(&mut fx.svm, 10);
    claim_dispute_timeout(&mut fx, escrow, vault).expect("claim dispute timeout");
    assert_eq!(token_balance(&fx.svm, fx.buyer_ata), BUYER_START_BALANCE);
    assert_eq!(token_balance(&fx.svm, fx.treasury_ata), 0);
    assert_eq!(reputation_of(&fx.svm, &fx.seller.pubkey()), (0, 0, 0, 0, 0), "nobody was found at fault");

    fails_with(resolve_dispute(&mut fx, escrow, vault, true, RATIONALE_HASH), 6006);
}

#[test]
fn wrong_signer_and_wrong_status_are_rejected() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);

    // Buyer cannot start execution (only the seller can).
    let bad_ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.buyer.pubkey(), true),
            AccountMeta::new(escrow, false),
        ],
        data: sighash("start_execution").to_vec(),
    };
    let buyer = fx.buyer.insecure_clone();
    fails_with(send(&mut fx.svm, &[bad_ix], &buyer, &[&buyer]), 6013);

    // Cannot settle an escrow that was never delivered.
    fails_with(accept_and_settle(&mut fx, escrow, vault), 6006);

    // Cannot raise a dispute before delivery.
    fails_with(raise_dispute(&mut fx, escrow, REASON_HASH), 6006);
}

#[test]
fn rejects_a_token_account_of_the_wrong_mint() {
    let mut fx = setup(60, 1, 60);
    let other_mint = Pubkey::new_unique();
    set_token_account(&mut fx.svm, other_mint, mint_bytes(fx.admin.pubkey()));
    let wrong_mint_ata = Pubkey::new_unique();
    set_token_account(
        &mut fx.svm,
        wrong_mint_ata,
        token_account_bytes(other_mint, fx.buyer.pubkey(), AMOUNT),
    );
    fx.buyer_ata = wrong_mint_ata;

    let id = fx.first_escrow_id;
    let (escrow, _) = escrow_pda(id);
    let (vault, _) = vault_pda(id);
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let mut data = sighash("create_and_fund_escrow").to_vec();
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&TASK_HASH);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fx.buyer.pubkey(), true),
            AccountMeta::new_readonly(fx.seller.pubkey(), false),
            AccountMeta::new(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.buyer_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::id(), false),
        ],
        data,
    };
    let buyer = fx.buyer.insecure_clone();
    fails_with(send(&mut fx.svm, &[ix], &buyer, &[&buyer]), 6014);
}

#[test]
fn only_the_buyer_can_accept_and_the_treasury_account_is_checked() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());

    let build = |signer: Pubkey, treasury: Pubkey, config: Pubkey, fx: &Fixture| Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new_readonly(config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.seller_ata, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data: sighash("accept_and_settle").to_vec(),
    };

    // A stranger (not the buyer) cannot settle early.
    let stranger = fx.seller.insecure_clone();
    let ix = build(stranger.pubkey(), fx.treasury_ata, fx.config, &fx);
    fails_with(send(&mut fx.svm, &[ix], &stranger, &[&stranger]), 6013);

    // The buyer cannot divert the fee to a token account the treasury does not own.
    let attacker_ata = Pubkey::new_unique();
    set_token_account(&mut fx.svm, attacker_ata, token_account_bytes(fx.mint, fx.buyer.pubkey(), 0));
    let buyer = fx.buyer.insecure_clone();
    let ix = build(buyer.pubkey(), attacker_ata, fx.config, &fx);
    fails_with(send(&mut fx.svm, &[ix], &buyer, &[&buyer]), 6013);

    // Nothing moved, and the honest call still works.
    assert_eq!(token_balance(&fx.svm, vault), AMOUNT);
    accept_and_settle(&mut fx, escrow, vault).expect("settle");
}

#[test]
fn arbiter_must_pay_the_right_party() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    raise_dispute(&mut fx, escrow, REASON_HASH).expect("dispute");

    // Ruling "refund the buyer" but passing the seller's account must fail.
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let mut data = sighash("resolve_dispute").to_vec();
    data.push(0);
    data.extend_from_slice(&RATIONALE_HASH);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(fx.arbiter.pubkey(), true),
            AccountMeta::new_readonly(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.seller_ata, false),
            AccountMeta::new(fx.treasury_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ],
        data,
    };
    let arbiter = fx.arbiter.insecure_clone();
    fails_with(send(&mut fx.svm, &[ix], &arbiter, &[&arbiter]), 6013);
    assert_eq!(token_balance(&fx.svm, vault), AMOUNT);

    // A non-arbiter cannot rule at all.
    fx.arbiter = fx.seller.insecure_clone();
    fails_with(resolve_dispute(&mut fx, escrow, vault, true, RATIONALE_HASH), 6013);
}

#[test]
fn zero_hashes_are_rejected_like_the_evm_contract() {
    let mut fx = setup(60, 1, 60);

    // taskHash == 0 cannot create an escrow.
    let before = fx.first_escrow_id;
    let id = before;
    let (escrow, _) = escrow_pda(id);
    let (vault, _) = vault_pda(id);
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let mut data = sighash("create_and_fund_escrow").to_vec();
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&[0u8; 32]);
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fx.buyer.pubkey(), true),
            AccountMeta::new_readonly(fx.seller.pubkey(), false),
            AccountMeta::new(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(fx.mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(fx.buyer_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::id(), false),
        ],
        data,
    };
    let buyer = fx.buyer.insecure_clone();
    fails_with(send(&mut fx.svm, &[ix], &buyer, &[&buyer]), 6015);

    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    fails_with(raise_dispute(&mut fx, escrow, [0u8; 32]), 6015);
    raise_dispute(&mut fx, escrow, REASON_HASH).expect("dispute");
    fails_with(submit_dispute_response(&mut fx, escrow, [0u8; 32]), 6015);
    submit_dispute_response(&mut fx, escrow, RESPONSE_HASH).expect("response");
    fails_with(submit_dispute_response(&mut fx, escrow, RESPONSE_HASH), 6009);
    fails_with(resolve_dispute(&mut fx, escrow, vault, true, [0u8; 32]), 6015);
    assert_eq!(token_balance(&fx.svm, vault), AMOUNT);
}

#[test]
fn the_escrow_token_is_the_deployments_mint_only() {
    let mut fx = setup(60, 1, 60);
    let other_mint = Pubkey::new_unique();
    set_token_account(&mut fx.svm, other_mint, mint_bytes(fx.admin.pubkey()));
    let other_ata = Pubkey::new_unique();
    set_token_account(&mut fx.svm, other_ata, token_account_bytes(other_mint, fx.buyer.pubkey(), AMOUNT));

    let id = fx.first_escrow_id;
    let (escrow, _) = escrow_pda(id);
    let (vault, _) = vault_pda(id);
    let (reputation, _) = reputation_pda(&fx.seller.pubkey());
    let mut data = sighash("create_and_fund_escrow").to_vec();
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&60i64.to_le_bytes());
    data.extend_from_slice(&TASK_HASH);
    // A consistent set of accounts, but for a mint the deployment was not initialized with.
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(fx.buyer.pubkey(), true),
            AccountMeta::new_readonly(fx.seller.pubkey(), false),
            AccountMeta::new(fx.config, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(other_mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(other_ata, false),
            AccountMeta::new(reputation, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::id(), false),
        ],
        data,
    };
    let buyer = fx.buyer.insecure_clone();
    fails_with(send(&mut fx.svm, &[ix], &buyer, &[&buyer]), 6014);
    assert_eq!(token_balance(&fx.svm, other_ata), AMOUNT);
}

#[test]
fn fee_changes_are_admin_only_and_never_touch_an_existing_escrow() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH); // created at 2.5%

    let treasury_owner = Pubkey::new_unique();
    let mut args = 1000u16.to_le_bytes().to_vec(); // 10%
    args.extend_from_slice(treasury_owner.as_ref());

    let stranger = fx.seller.insecure_clone();
    fails_with(admin_ix(&mut fx, &stranger, "set_fee", &args), 6013);

    let admin = fx.admin.insecure_clone();
    let mut too_high = 1001u16.to_le_bytes().to_vec();
    too_high.extend_from_slice(treasury_owner.as_ref());
    fails_with(admin_ix(&mut fx, &admin, "set_fee", &too_high), 6000);

    // The rate moves to 10% and the treasury owner changes, but this escrow keeps 2.5%
    // - so it must still settle to the treasury account it was created against.
    let treasury_ata_before = fx.treasury_ata;
    let mut same_treasury = 1000u16.to_le_bytes().to_vec();
    let config_acc = fx.svm.get_account(&fx.config).unwrap();
    same_treasury.extend_from_slice(&config_acc.data[8 + 64..8 + 96]); // current treasury
    admin_ix(&mut fx, &admin, "set_fee", &same_treasury).expect("admin sets the fee");

    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    accept_and_settle(&mut fx, escrow, vault).expect("settle");
    assert_eq!(token_balance(&fx.svm, treasury_ata_before), FEE, "the fee rate was fixed at creation");

    // A new escrow now carries the new 10% rate.
    let (id2, escrow2, vault2) = create_and_fund_second(&mut fx);
    assert_eq!(id2, 2);
    start_execution(&mut fx, escrow2);
    mark_delivered(&mut fx, escrow2, RESULT_HASH);
    accept_and_settle(&mut fx, escrow2, vault2).expect("settle 2");
    assert_eq!(token_balance(&fx.svm, treasury_ata_before), FEE + AMOUNT / 10);
}

fn create_and_fund_second(fx: &mut Fixture) -> (u64, Pubkey, Pubkey) {
    fx.first_escrow_id = 2;
    create_and_fund(fx, AMOUNT, 60, 60, [12u8; 32])
}

#[test]
fn the_arbiter_can_be_handed_over_by_the_admin_only() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);
    raise_dispute(&mut fx, escrow, REASON_HASH).expect("dispute");

    let new_arbiter = Keypair::new();
    fx.svm.airdrop(&new_arbiter.pubkey(), 1_000_000_000).unwrap();
    let stranger = fx.seller.insecure_clone();
    fails_with(admin_ix(&mut fx, &stranger, "set_arbiter", new_arbiter.pubkey().as_ref()), 6013);
    let admin = fx.admin.insecure_clone();
    admin_ix(&mut fx, &admin, "set_arbiter", new_arbiter.pubkey().as_ref()).expect("set arbiter");

    // The old arbiter can no longer rule; the new one can.
    fails_with(resolve_dispute(&mut fx, escrow, vault, true, RATIONALE_HASH), 6013);
    fx.arbiter = new_arbiter;
    resolve_dispute(&mut fx, escrow, vault, true, RATIONALE_HASH).expect("new arbiter rules");
}

#[test]
fn a_dispute_cannot_be_raised_after_the_review_window_and_deadlines_are_inclusive() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 60, 5, TASK_HASH);
    start_execution(&mut fx, escrow);
    mark_delivered(&mut fx, escrow, RESULT_HASH);

    // Exactly at the deadline the buyer may still dispute and nobody may finalize yet
    // (start/dispute use `<=`, the permissionless claims use `>`, as in AgentEco.sol).
    warp_seconds(&mut fx.svm, 5);
    fails_with(finalize_after_review_window(&mut fx, escrow, vault), 6008);
    warp_seconds(&mut fx.svm, 1);
    fails_with(raise_dispute(&mut fx, escrow, REASON_HASH), 6007);
    finalize_after_review_window(&mut fx, escrow, vault).expect("finalize after the window");
}

#[test]
fn late_delivery_is_accepted_until_someone_claims_the_timeout() {
    let mut fx = setup(60, 1, 60);
    let (_, escrow, vault) = create_and_fund(&mut fx, AMOUNT, 5, 60, TASK_HASH);
    start_execution(&mut fx, escrow);
    warp_seconds(&mut fx.svm, 10); // past the execution deadline
    mark_delivered(&mut fx, escrow, RESULT_HASH); // whichever comes first wins
    fails_with(claim_execution_timeout(&mut fx, escrow, vault), 6006);
    accept_and_settle(&mut fx, escrow, vault).expect("settle");
}

#[test]
fn a_seller_cannot_start_after_the_accept_window() {
    let mut fx = setup(5, 1, 60);
    let (_, escrow, _vault) = create_and_fund(&mut fx, AMOUNT, 60, 60, TASK_HASH);
    warp_seconds(&mut fx.svm, 10);
    fails_with(start_execution_result(&mut fx, escrow), 6007);
}
