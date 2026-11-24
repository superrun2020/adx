package main

import (
	"bytes"
	"os"
	"testing"
)

func TestBuildSignedContractPDF(t *testing.T) {
	signature := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII="
	_, signatureHash, err := parseRegistrationSignature(signature)
	if err != nil {
		t.Fatal(err)
	}
	contractText := renderRegistrationContract(channelRegistrationInput{CompanyName: "Example Media Ltd", RegisteredAddress: "1 Example Street", ContactName: "Jordan Example", Phone: "+852 5555 1234", Email: "jordan@example.test", SignatureName: "Jordan Example", RegistrationNumber: "REG-12345", Country: "Hong Kong"})
	record := signedContractPDF{RegistrationID: 1, CompanyName: "Example Media Ltd", Version: "v1", Text: contractText, TextHash: contractTextHash(contractText), SignerName: "Jordan Example", SignerTitle: "Director", SignerEmail: "jordan@example.test", SignatureData: signature, SignatureHash: signatureHash, SignedAt: "2026-11-23T00:00:00Z", CounterSigner: "Admin", CounterSignerTitle: "Director", CounterSignatureData: signature, CounterSignatureHash: signatureHash, CountersignedAt: "2026-11-24T00:00:00Z"}
	pdf, err := buildSignedContractPDF(record)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatal("not a PDF")
	}
	if path := os.Getenv("CONTRACT_PDF_TEST_OUTPUT"); path != "" {
		if err := os.WriteFile(path, pdf, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
