`spl_token.so` is the SPL Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) as deployed on devnet, for the Rust litesvm tests (litesvm 0.10 does not bundle it):

    solana program dump TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA spl_token.so --url https://api.devnet.solana.com
    sha256  8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697

It is only ever loaded into the in-process test VM, never deployed from here.
