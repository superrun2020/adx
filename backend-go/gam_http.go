package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var networkPattern = regexp.MustCompile("^[0-9]{6,}$")
var adUnitPattern = regexp.MustCompile("^networks/([0-9]+)/adUnits/([0-9]+)$")
var sitePattern = regexp.MustCompile("^networks/([0-9]+)/sites/([0-9]+)$")
var reportPattern = regexp.MustCompile("^networks/([0-9]+)/reports/([0-9]+)$")
var operationPattern = regexp.MustCompile("^networks/([0-9]+)/operations/reports/runs/([0-9]+)$")
var resultPattern = regexp.MustCompile("^networks/([0-9]+)/reports/([0-9]+)/results/([0-9]+)$")

type gamTokenEntry struct {
	cipher, token string
	expires       time.Time
	ready         chan struct{}
	err           error
}

func resourceForNetwork(pattern *regexp.Regexp, name, network, code string) error {
	match := pattern.FindStringSubmatch(name)
	if len(match) == 0 || match[1] != network {
		return errors.New(code)
	}
	return nil
}
func networkCode(raw string) (string, error) {
	code := strings.TrimSpace(raw)
	if !networkPattern.MatchString(code) {
		return "", errors.New("invalid_network_code")
	}
	return code, nil
}
func (a *app) gamRequest(ctx context.Context, network, token, resource, method string, query url.Values, body any) (map[string]any, error) {
	code, err := networkCode(network)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, errors.New("missing_gam_access_token")
	}
	if resource != "networks/"+code && !strings.HasPrefix(resource, "networks/"+code+"/") {
		return nil, errors.New("invalid_gam_resource")
	}
	endpoint, err := url.Parse(a.gamAPIBase + resource)
	if err != nil {
		return nil, err
	}
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	retryable := method == http.MethodGet || method == http.MethodPatch
	attempts := 1
	if retryable {
		attempts = 3
	}
	var payload []byte
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	for attempt := 0; attempt < attempts; attempt++ {
		requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		req, err := http.NewRequestWithContext(requestCtx, method, endpoint.String(), bytes.NewReader(payload))
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		client := a.gamClient
		if client == nil {
			client = http.DefaultClient
		}
		response, err := client.Do(req)
		if err != nil {
			cancel()
			if retryable && attempt+1 < attempts {
				if err = sleepContext(ctx, time.Duration(250<<attempt)*time.Millisecond); err == nil {
					continue
				}
			}
			return nil, err
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, (64<<20)+1))
		response.Body.Close()
		cancel()
		if readErr != nil {
			return nil, readErr
		}
		if len(data) > 64<<20 {
			return nil, errors.New("gam_response_too_large")
		}
		result := map[string]any{}
		if err := json.Unmarshal(data, &result); err != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
			return nil, errors.New("invalid_gam_response")
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return result, nil
		}
		transient := response.StatusCode == 429 || response.StatusCode == 500 || response.StatusCode == 502 || response.StatusCode == 503 || response.StatusCode == 504
		if retryable && transient && attempt+1 < attempts {
			delay := time.Duration(250<<attempt) * time.Millisecond
			if seconds, e := strconv.ParseFloat(response.Header.Get("Retry-After"), 64); e == nil && seconds > 0 {
				delay = time.Duration(seconds * float64(time.Second))
				if delay > 5*time.Second {
					delay = 5 * time.Second
				}
			}
			if err = sleepContext(ctx, delay); err == nil {
				continue
			}
			return nil, err
		}
		detail := "request_failed"
		if block, ok := result["error"].(map[string]any); ok {
			if message := importString(block["message"]); message != "" {
				detail = message
			} else if status := importString(block["status"]); status != "" {
				detail = status
			}
		}
		if len(detail) > 400 {
			detail = detail[:400]
		}
		return nil, fmt.Errorf("gam_http_%d: %s", response.StatusCode, detail)
	}
	return nil, errors.New("gam_request_failed")
}
func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func (a *app) serviceToken(ctx context.Context, credentials map[string]any) (string, time.Duration, error) {
	email, key := importString(credentials["client_email"]), importString(credentials["private_key"])
	if email == "" || key == "" {
		return "", 0, errors.New("invalid_service_account_json")
	}
	if uri := importString(credentials["token_uri"]); uri != "" && uri != "https://oauth2.googleapis.com/token" {
		return "", 0, errors.New("invalid_service_account_token_uri")
	}
	block, _ := pem.Decode([]byte(key))
	if block == nil {
		return "", 0, errors.New("invalid_service_account_json")
	}
	var privateKey *rsa.PrivateKey
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		privateKey, _ = parsed.(*rsa.PrivateKey)
	}
	if privateKey == nil {
		privateKey, _ = x509.ParsePKCS1PrivateKey(block.Bytes)
	}
	if privateKey == nil {
		return "", 0, errors.New("invalid_service_account_json")
	}
	now := time.Now().Unix()
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"iss": email, "scope": "https://www.googleapis.com/auth/admanager", "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now + 3600})
	encode := base64.RawURLEncoding.EncodeToString
	unsigned := encode(header) + "." + encode(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", 0, err
	}
	values := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {unsigned + "." + encode(signature)}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, a.oauthURL, strings.NewReader(values.Encode()))
	if err != nil {
		return "", 0, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := a.gamClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return "", 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", 0, err
	}
	result := map[string]any{}
	_ = json.Unmarshal(data, &result)
	token := importString(result["access_token"])
	if response.StatusCode < 200 || response.StatusCode >= 300 || token == "" {
		return "", 0, fmt.Errorf("oauth_%d_%s", response.StatusCode, importString(result["error"]))
	}
	ttl := time.Duration(numberValue(result["expires_in"])) * time.Second
	if ttl <= 0 {
		ttl = time.Hour
	}
	return token, ttl, nil
}
func (a *app) tokenFor(ctx context.Context, account map[string]any) (string, error) {
	id := int64(numberValue(account["id"]))
	cipher := importString(account["credential_ciphertext"])
	a.gamMu.Lock()
	if cached := a.gamTokens[id]; cached != nil && cached.cipher == cipher {
		if cached.ready != nil {
			ready := cached.ready
			a.gamMu.Unlock()
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-ready:
				return cached.token, cached.err
			}
		}
		if cached.token != "" && time.Until(cached.expires) > 5*time.Minute {
			a.gamMu.Unlock()
			return cached.token, nil
		}
	}
	entry := &gamTokenEntry{cipher: cipher, ready: make(chan struct{})}
	a.gamTokens[id] = entry
	a.gamMu.Unlock()
	credentials, err := a.decryptCredential(cipher)
	var token string
	var ttl time.Duration
	if err == nil {
		token, ttl, err = a.serviceToken(ctx, credentials)
	}
	a.gamMu.Lock()
	entry.token = token
	entry.err = err
	entry.expires = time.Now().Add(ttl)
	close(entry.ready)
	entry.ready = nil
	if err != nil && a.gamTokens[id] == entry {
		delete(a.gamTokens, id)
	}
	a.gamMu.Unlock()
	return token, err
}
func (a *app) lockGam(id int64) bool {
	a.gamMu.Lock()
	defer a.gamMu.Unlock()
	if a.gamBusy[id] {
		return false
	}
	a.gamBusy[id] = true
	return true
}
func (a *app) unlockGam(id int64) { a.gamMu.Lock(); delete(a.gamBusy, id); a.gamMu.Unlock() }
func gamRoute(next func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := next(w, r); err != nil {
			detail := err.Error()
			if len(detail) > 500 {
				detail = detail[:500]
			}
			status := 500
			if strings.HasPrefix(detail, "invalid_") || strings.HasPrefix(detail, "unsupported_") || strings.HasPrefix(detail, "duplicate_") || strings.HasPrefix(detail, "rest_report_not_configured") || strings.HasPrefix(detail, "rest_report_mapping_inactive") || strings.HasPrefix(detail, "rest_preview_required") {
				status = 400
			} else if strings.Contains(detail, "busy") || strings.Contains(detail, "already_created") || strings.Contains(detail, "already_exists") || strings.Contains(detail, "_mismatch") {
				status = 409
			} else if strings.HasPrefix(detail, "gam_http_") || strings.HasPrefix(detail, "oauth_") {
				status = 502
			}
			writeError(w, status, detail)
		}
	}
}
