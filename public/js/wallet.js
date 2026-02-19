// Solana Phantom wallet integration
const Wallet = (() => {
  let publicKey = null;

  function getProvider() {
    if ('phantom' in window && window.phantom?.solana?.isPhantom) {
      return window.phantom.solana;
    }
    return null;
  }

  async function connect() {
    const provider = getProvider();
    if (!provider) {
      // For development/testing without Phantom installed, generate a mock address
      const mockAddr = 'Dev' + Math.random().toString(36).slice(2, 10);
      publicKey = mockAddr;
      return { publicKey: mockAddr, mock: true };
    }

    try {
      const resp = await provider.connect();
      publicKey = resp.publicKey.toString();
      return { publicKey, mock: false };
    } catch (err) {
      throw new Error('Wallet connection rejected');
    }
  }

  async function sendBet(amountSOL, recipientPubkey) {
    const provider = getProvider();
    if (!provider) {
      console.log(`[Mock] Would send ${amountSOL} SOL to ${recipientPubkey}`);
      return { signature: 'mock_' + Date.now(), mock: true };
    }

    // Real Solana transaction via Phantom
    const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = window.solanaWeb3 || {};
    if (!Connection) {
      console.warn('solana/web3.js not loaded on client — using mock');
      return { signature: 'mock_' + Date.now(), mock: true };
    }

    const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: new PublicKey(recipientPubkey),
        lamports: Math.floor(amountSOL * LAMPORTS_PER_SOL),
      })
    );

    transaction.feePayer = provider.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    const signed = await provider.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    return { signature, mock: false };
  }

  function getPublicKey() {
    return publicKey;
  }

  function shortenAddress(addr) {
    if (!addr) return '';
    if (addr.length <= 10) return addr;
    return addr.slice(0, 4) + '...' + addr.slice(-4);
  }

  return { connect, sendBet, getPublicKey, shortenAddress };
})();
