import { describe, it, expect } from "vitest";
import { passesLuhn } from "./luhn.js";

describe("passesLuhn", () => {
  it("validates known test card numbers", () => {
    // Visa
    expect(passesLuhn("4111111111111111")).toBe(true);
    // MasterCard
    expect(passesLuhn("5500000000000004")).toBe(true);
    // Amex
    expect(passesLuhn("378282246310005")).toBe(true);
    // Discover
    expect(passesLuhn("6011111111111117")).toBe(true);
  });

  it("rejects numbers that fail the check", () => {
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(passesLuhn("1234567890123456")).toBe(false);
  });

  it("strips non-digit characters before checking", () => {
    expect(passesLuhn("4111 1111 1111 1111")).toBe(true);
    expect(passesLuhn("4111-1111-1111-1111")).toBe(true);
  });

  it("rejects too-short and too-long sequences", () => {
    expect(passesLuhn("123456789012")).toBe(false); // 12 digits
    expect(passesLuhn("12345678901234567890")).toBe(false); // 20 digits
  });
});
