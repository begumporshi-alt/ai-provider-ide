//! keychain-vault (L0): the ONLY home of raw secrets (invariants 1, 10, 14).
//! OS keychain via `keyring` v3, service `ai-provider-ide`, accounts `key:<keyId>` for
//! provider keys and `masterkey` for the Local Gateway master key (Phase 2b).

use keyring::Entry;

pub const SERVICE: &str = "ai-provider-ide";

#[derive(thiserror::Error, Debug)]
pub enum VaultError {
    #[error("keychain error for {account}: {source}")]
    Keychain {
        account: String,
        #[source]
        source: keyring::Error,
    },
}

pub fn put(account: &str, secret: &str) -> Result<(), VaultError> {
    let e = Entry::new(SERVICE, account)
        .map_err(|source| VaultError::Keychain { account: account.into(), source })?;
    e.set_password(secret)
        .map_err(|source| VaultError::Keychain { account: account.into(), source })
}

pub fn get(account: &str) -> Result<Option<String>, VaultError> {
    let e = Entry::new(SERVICE, account)
        .map_err(|source| VaultError::Keychain { account: account.into(), source })?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(source) => Err(VaultError::Keychain { account: account.into(), source }),
    }
}

pub fn delete(account: &str) -> Result<(), VaultError> {
    let e = Entry::new(SERVICE, account)
        .map_err(|source| VaultError::Keychain { account: account.into(), source })?;
    match e.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(source) => Err(VaultError::Keychain { account: account.into(), source }),
    }
}
