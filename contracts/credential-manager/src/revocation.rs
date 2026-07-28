use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol, Vec};
use crate::types::Credential;
use crate::keys::{CRED, cred_key};

pub fn revoke_credential(env: &Env, issuer: Address, credential_id: BytesN<32>) {
    issuer.require_auth();

    let key = cred_key(&credential_id);
    let mut cred: Credential = env
        .storage()
        .persistent()
        .get(&key)
        .expect("credential not found");

    if cred.issuer != issuer {
        panic!("only the issuer can revoke");
    }

    cred.revoked = true;
    env.storage().persistent().set(&key, &cred);
    env.events().publish((CRED, symbol_short!("revoked")), credential_id);
}

/// Issue #602: atomically revoke up to 50 credentials in one call.
///
/// Panics if `ids` contains more than 50 entries, if any credential is not
/// found, if the caller is not the issuer of every credential, or if any
/// credential is already revoked. No partial revocations are written.
pub fn revoke_credentials_batch(
    env: &Env,
    issuer: Address,
    ids: Vec<BytesN<32>>,
    reason: Symbol,
) {
    issuer.require_auth();
    assert!(ids.len() <= 50, "batch too large: max 50 credential IDs per call");
    for id in ids.iter() {
        let key = cred_key(&id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .expect("credential not found");
        assert_eq!(cred.issuer, issuer, "only the issuer can revoke");
        assert!(!cred.revoked, "credential already revoked");
        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        env.events().publish(
            (CRED, symbol_short!("revoked")),
            (id, issuer.clone(), reason.clone()),
        );
    }
}

pub fn verify_credential(env: &Env, credential_id: BytesN<32>) -> bool {
    let key = cred_key(&credential_id);
    match env
        .storage()
        .persistent()
        .get::<(Symbol, BytesN<32>), Credential>(&key)
    {
        None => false,
        Some(cred) => {
            if cred.revoked {
                return false;
            }
            if cred.expires_at > 0 && env.ledger().timestamp() > cred.expires_at {
                return false;
            }
            true
        }
    }
}
