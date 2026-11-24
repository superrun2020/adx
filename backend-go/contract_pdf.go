package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-pdf/fpdf"
)

//go:embed fonts/NotoSansSC-Regular.ttf
var contractPDFFont []byte

type signedContractPDF struct {
	RegistrationID       int64
	CompanyName          string
	Version              string
	Text                 string
	TextHash             string
	SignerName           string
	SignerTitle          string
	SignerEmail          string
	SignatureData        string
	SignatureHash        string
	SignedAt             string
	CounterSigner        string
	CounterSignerTitle   string
	CounterSignatureData string
	CounterSignatureHash string
	CountersignedAt      string
}

func signatureImage(dataURL string) ([]byte, string, error) {
	if _, _, err := parseRegistrationSignature(dataURL); err != nil {
		return nil, "", err
	}
	parts := strings.SplitN(dataURL, ",", 2)
	image, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, "", err
	}
	if strings.HasPrefix(parts[0], "data:image/png;") {
		return image, "PNG", nil
	}
	return image, "JPG", nil
}

func buildSignedContractPDF(record signedContractPDF) ([]byte, error) {
	if record.Text == "" || record.TextHash != contractTextHash(record.Text) || record.SignedAt == "" || record.CountersignedAt == "" {
		return nil, errors.New("invalid_signed_contract")
	}
	channelImage, channelType, err := signatureImage(record.SignatureData)
	if err != nil {
		return nil, err
	}
	adminImage, adminType, err := signatureImage(record.CounterSignatureData)
	if err != nil {
		return nil, err
	}
	channelDigest := sha256.Sum256(channelImage)
	adminDigest := sha256.Sum256(adminImage)
	if hex.EncodeToString(channelDigest[:]) != record.SignatureHash || hex.EncodeToString(adminDigest[:]) != record.CounterSignatureHash {
		return nil, errors.New("invalid_signature_hash")
	}

	pdf := fpdf.New("P", "mm", "A4", "")
	issuer := "AdX Publisher"
	if record.Version == channelAgreementVersion {
		issuer = "JUNGLELABS LTD"
	}
	pdf.SetTitle("AdX 合作协议 - "+record.CompanyName, true)
	pdf.SetAuthor(issuer, true)
	pdf.SetMargins(18, 20, 18)
	pdf.SetAutoPageBreak(true, 20)
	pdf.AddUTF8FontFromBytes("NotoSC", "", contractPDFFont)
	if err := pdf.Error(); err != nil {
		return nil, err
	}
	pdf.SetFooterFunc(func() {
		pdf.SetY(-13)
		pdf.SetFont("NotoSC", "", 8)
		pdf.SetTextColor(125, 140, 154)
		pdf.CellFormat(0, 5, fmt.Sprintf("%s  |  %d", issuer, pdf.PageNo()), "", 0, "C", false, 0, "")
	})
	pdf.AddPage()
	pdf.SetFont("NotoSC", "", 16)
	pdf.SetTextColor(24, 54, 78)
	pdf.MultiCell(0, 10, "合作协议", "", "C", false)
	pdf.SetFont("NotoSC", "", 9)
	pdf.SetTextColor(113, 128, 142)
	pdf.MultiCell(0, 6, "签约主体："+record.CompanyName, "", "C", false)
	pdf.Ln(5)
	for _, raw := range strings.Split(strings.ReplaceAll(record.Text, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			pdf.Ln(3)
			continue
		}
		if strings.Contains("合同项下可能涉及之名词解释|合同有效期|服务方式及结算|结算时间|甲方之陈述保证与权力义务|乙方之陈述保证与权力义务|甲乙双方的禁止性约定|不可抗力|违约责任|争议解决|其它约定|反商业贿赂条款", line) && len([]rune(line)) > 3 {
			pdf.Ln(3)
			pdf.SetTextColor(24, 80, 132)
			pdf.SetFont("NotoSC", "", 11)
			pdf.MultiCell(0, 7, line, "", "L", false)
		} else {
			pdf.SetTextColor(46, 62, 76)
			pdf.SetFont("NotoSC", "", 9.5)
			pdf.MultiCell(0, 5.7, line, "", "L", false)
		}
		pdf.Ln(1.5)
	}
	pdf.AddPage()
	pdf.SetFont("NotoSC", "", 16)
	pdf.SetTextColor(24, 54, 78)
	pdf.MultiCell(0, 10, "双方电子签署记录", "", "C", false)
	pdf.Ln(10)
	pdf.SetFont("NotoSC", "", 10)
	pdf.SetTextColor(46, 62, 76)
	for _, line := range []string{
		"乙方主体：" + record.CompanyName,
		"乙方签署人：" + record.SignerName + "  职务：" + record.SignerTitle,
		"签署邮箱：" + record.SignerEmail,
		"乙方签署时间（UTC）：" + record.SignedAt,
		"甲方签署人：" + record.CounterSigner + "  职务：" + record.CounterSignerTitle,
		"甲方签署时间（UTC）：" + record.CountersignedAt,
	} {
		pdf.MultiCell(0, 8, line, "", "L", false)
	}
	pdf.Ln(10)
	left, right, y := 20.0, 112.0, pdf.GetY()
	pdf.SetFont("NotoSC", "", 10)
	pdf.CellFormat(80, 8, "乙方手写签名", "", 0, "L", false, 0, "")
	pdf.CellFormat(80, 8, "甲方手写签名", "", 1, "L", false, 0, "")
	y += 10
	pdf.RegisterImageOptionsReader("channel-signature", fpdf.ImageOptions{ImageType: channelType}, bytes.NewReader(channelImage))
	pdf.RegisterImageOptionsReader("admin-signature", fpdf.ImageOptions{ImageType: adminType}, bytes.NewReader(adminImage))
	pdf.ImageOptions("channel-signature", left, y, 74, 22, false, fpdf.ImageOptions{ImageType: channelType}, 0, "")
	pdf.ImageOptions("admin-signature", right, y, 74, 22, false, fpdf.ImageOptions{ImageType: adminType}, 0, "")
	pdf.SetY(y + 32)
	pdf.SetTextColor(113, 128, 142)
	pdf.SetFont("NotoSC", "", 8)
	pdf.MultiCell(0, 6, "协议正文 SHA-256："+record.TextHash, "", "L", false)
	pdf.MultiCell(0, 6, "协议内容与双方签名已按上述时间留存。PDF 文件的 SHA-256 校验值由系统另行保存。", "", "L", false)
	if err := pdf.Error(); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := pdf.Output(&output); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func (a *app) sendContractPDF(w http.ResponseWriter, r *http.Request, registrationID int64) {
	var record signedContractPDF
	var stored []byte
	var storedHash string
	err := a.db.QueryRowContext(r.Context(), "SELECT r.id,r.company_name,c.version,c.contract_text,c.contract_hash,c.signer_name,c.signer_title,c.signer_email,c.signature_data,c.signature_hash,c.signed_at,c.counter_signer,c.counter_signer_title,c.counter_signature_data,c.counter_signature_hash,c.countersigned_at,c.signed_pdf,c.signed_pdf_sha256 FROM channel_registrations r JOIN channel_registration_contracts c ON c.registration_id=r.id WHERE r.id=? AND r.status='approved' AND c.countersigned_at IS NOT NULL", registrationID).
		Scan(&record.RegistrationID, &record.CompanyName, &record.Version, &record.Text, &record.TextHash, &record.SignerName, &record.SignerTitle, &record.SignerEmail, &record.SignatureData, &record.SignatureHash, &record.SignedAt, &record.CounterSigner, &record.CounterSignerTitle, &record.CounterSignatureData, &record.CounterSignatureHash, &record.CountersignedAt, &stored, &storedHash)
	if err == sql.ErrNoRows {
		writeError(w, 404, "signed_contract_not_ready")
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if len(stored) == 0 {
		stored, err = buildSignedContractPDF(record)
		if err != nil {
			serverError(w, err)
			return
		}
		digest := sha256.Sum256(stored)
		_, err = a.db.ExecContext(r.Context(), "UPDATE channel_registration_contracts SET signed_pdf=?,signed_pdf_sha256=?,signed_pdf_created_at=CURRENT_TIMESTAMP WHERE registration_id=? AND signed_pdf IS NULL", stored, hex.EncodeToString(digest[:]), registrationID)
		if err != nil {
			serverError(w, err)
			return
		}
		storedHash = hex.EncodeToString(digest[:])
	}
	verified := sha256.Sum256(stored)
	if hex.EncodeToString(verified[:]) != storedHash {
		writeError(w, 500, "signed_contract_integrity_failed")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=adx-contract-%d.pdf", record.RegistrationID))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(stored)))
	_, _ = w.Write(stored)
}

func (a *app) channelContractPDF(w http.ResponseWriter, r *http.Request) {
	var id int64
	err := a.db.QueryRowContext(r.Context(), "SELECT id FROM channel_registrations WHERE user_id=? AND status='approved'", currentUser(r).ID).Scan(&id)
	if err != nil {
		writeError(w, 404, "signed_contract_not_ready")
		return
	}
	a.sendContractPDF(w, r, id)
}

func (a *app) adminContractPDF(w http.ResponseWriter, r *http.Request) {
	a.sendContractPDF(w, r, pathID(r))
}
