// SPDX-FileCopyrightText: 2026 PlaiPin Inc
// SPDX-License-Identifier: Apache-2.0

// Shared constants for the USB-CDC pairing protocol. The device-side pair
// implementation must use the same magic preamble; drift breaks the wire
// format silently.

/**
 * Magic preamble. Lines beginning with this string are treated as
 * pairing-protocol JSON-RPC frames; everything else flows through as
 * regular log output. The trailing space is part of the magic.
 */
export const PLAIPIN_PAIR_MAGIC = "PLAIPIN-PAIR ";
