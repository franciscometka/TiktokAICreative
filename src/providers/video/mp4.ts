/** Assinatura ISO BMFF; a decodificação completa é responsabilidade do renderer. */
export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && Buffer.from(bytes).toString("ascii", 4, 8) === "ftyp";
}
