package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

func (a *app) initializeCredentialKey() error {
	configured := os.Getenv("ADX_CREDENTIAL_KEY")
	if len(configured) < 32 {
		if a.production {
			return errors.New("ADX_CREDENTIAL_KEY_REQUIRED")
		}
		configured = "local-development-only"
	}
	a.credentialKey = sha256.Sum256([]byte(configured))
	return nil
}

func (a *app) encryptCredential(value any) (string, error) {
	plain, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(a.credentialKey[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, plain, nil)
	tagSize := gcm.Overhead()
	encode := base64.RawURLEncoding.EncodeToString
	return strings.Join([]string{encode(iv), encode(sealed[len(sealed)-tagSize:]), encode(sealed[:len(sealed)-tagSize])}, "."), nil
}

func (a *app) decryptCredential(encoded string) (map[string]any, error) {
	parts := strings.Split(encoded, ".")
	if len(parts) != 3 {
		return nil, errors.New("invalid_credential_ciphertext")
	}
	decode := base64.RawURLEncoding.DecodeString
	iv, err := decode(parts[0])
	if err != nil {
		return nil, err
	}
	tag, err := decode(parts[1])
	if err != nil {
		return nil, err
	}
	data, err := decode(parts[2])
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(a.credentialKey[:])
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(plain, &result); err != nil {
		return nil, err
	}
	return result, nil
}
