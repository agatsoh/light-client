import { BigNumber } from '@ethersproject/bignumber';
import { concat as concatBytes, hexlify } from '@ethersproject/bytes';
import { HashZero } from '@ethersproject/constants';
import { keccak256 } from '@ethersproject/keccak256';
import { randomBytes } from '@ethersproject/random';
import { sha256 } from '@ethersproject/sha2';
import * as t from 'io-ts';
import isEmpty from 'lodash/isEmpty';
import type { Observable } from 'rxjs';
import { defer, from, of } from 'rxjs';
import { filter, first, map, mergeMap } from 'rxjs/operators';

import type { Channel } from '../channels';
import type { Lock } from '../channels/types';
import { BalanceProofZero } from '../channels/types';
import { channelUniqueKey } from '../channels/utils';
import { Capabilities } from '../constants';
import type { RaidenDatabase, TransferStateish } from '../db/types';
import type { RouteMetadata } from '../messages/types';
import { Metadata } from '../messages/types';
import {
  createBalanceHash,
  getBalanceProofFromEnvelopeMessage,
  validateAddressMetadata,
} from '../messages/utils';
import type { Paths } from '../services/types';
import type { RaidenState } from '../state';
import type { Via } from '../transport/types';
import { getCap, parseCaps } from '../transport/utils';
import { assert } from '../utils';
import { encode } from '../utils/data';
import type { Address, Hash, HexString, Secret, UInt } from '../utils/types';
import { decode, isntNil } from '../utils/types';
import type { transfer } from './actions';
import type { RaidenTransfer } from './state';
import { Direction, RaidenTransferStatus, TransferState } from './state';

/**
 * Get the locksroot of a given array of pending locks
 * On Alderaan, it's the keccak256 hash of the concatenation of the ordered locks data
 *
 * @param locks - Lock array to calculate the locksroot from
 * @returns hash of the locks array
 */
export function getLocksroot(locks: readonly Lock[]): Hash {
  const encoded: HexString[] = [];
  for (const lock of locks)
    encoded.push(encode(lock.expiration, 32), encode(lock.amount, 32), lock.secrethash);
  return keccak256(concatBytes(encoded)) as Hash;
}

/**
 * Return the secrethash of a given secret
 * On Alderaan, the sha256 hash is used for the secret.
 *
 * @param secret - Secret to get the hash from
 * @returns hash of the secret
 */
export function getSecrethash(secret: Secret): Hash {
  return sha256(secret) as Hash;
}

/**
 * Generates a random secret of given length, as an HexString<32>
 *
 * @param length - of the secret to generate
 * @returns HexString<32>
 */
export function makeSecret(length = 32): Secret {
  return hexlify(randomBytes(length)) as Secret;
}

/**
 * Generates a random payment identifier, as an UInt<8> (64 bits)
 *
 * @returns UInt<8>
 */
export function makePaymentId(): UInt<8> {
  return BigNumber.from(Date.now()) as UInt<8>;
}

/**
 * Generates a message identifier, as an UInt<8> (64 bits)
 *
 * @returns UInt<8>
 */
export function makeMessageId(): UInt<8> {
  return BigNumber.from(Date.now()) as UInt<8>;
}

/**
 * Get a unique key for a tranfer state or TransferId
 *
 * @param state - transfer to get key from, or TransferId
 * @returns string containing a unique key for transfer
 */
export function transferKey(
  state: TransferState | { secrethash: Hash; direction: Direction },
): string {
  if ('_id' in state) return state._id;
  return `${state.direction}:${state.secrethash}`;
}

const keyRe = new RegExp(`^(${Object.values(Direction).join('|')}):(0x[a-f0-9]{64})$`, 'i');
/**
 * Parse a transferKey into a TransferId object ({ secrethash, direction })
 *
 * @param key - string to parse as transferKey
 * @returns secrethash, direction contained in transferKey
 */
export function transferKeyToMeta(key: string): { secrethash: Hash; direction: Direction } {
  const match = key.match(keyRe);
  assert(match, 'Invalid transferKey format');
  const [, direction, secrethash] = match;
  return { direction: direction as Direction, secrethash: secrethash as Hash };
}

const statusesMap: { [K in RaidenTransferStatus]: (t: TransferState) => number | undefined } = {
  [RaidenTransferStatus.expired]: (t) => t.expiredProcessed?.ts,
  [RaidenTransferStatus.unlocked]: (t) => t.unlockProcessed?.ts,
  [RaidenTransferStatus.expiring]: (t) => t.expired?.ts,
  [RaidenTransferStatus.unlocking]: (t) => t.unlock?.ts,
  [RaidenTransferStatus.registered]: (t) => t.secretRegistered?.ts,
  [RaidenTransferStatus.revealed]: (t) => t.secretReveal?.ts,
  [RaidenTransferStatus.requested]: (t) => t.secretRequest?.ts,
  [RaidenTransferStatus.closed]: (t) => t.channelClosed?.ts,
  [RaidenTransferStatus.received]: (t) => t.transferProcessed?.ts,
  [RaidenTransferStatus.pending]: (t) => t.transfer.ts,
};

/**
 * @param state - Transfer state
 * @returns Transfer's status
 */
export function transferStatus(state: TransferState) {
  // order matters! from top to bottom priority, first match breaks loop
  for (const [s, g] of Object.entries(statusesMap)) {
    const ts = g(state);
    if (ts !== undefined) {
      return s as RaidenTransferStatus;
    }
  }
  return RaidenTransferStatus.pending;
}

/**
 * @param state - Transfer state
 * @returns Whether the transfer is considered completed
 */
export function transferCompleted(
  state: TransferState,
): state is TransferState &
  NonNullable<
    | Pick<TransferState, 'unlockProcessed'>
    | Pick<TransferState, 'expiredProcessed'>
    | Pick<TransferState, 'secretRegistered'>
    | Pick<TransferState, 'channelSettled'>
  > {
  return !!(
    state.unlockProcessed ||
    state.expiredProcessed ||
    state.secretRegistered ||
    state.channelSettled
  );
}

/**
 * Convert a TransferState to a public RaidenTransfer object
 *
 * @param state - RaidenState.sent value
 * @returns Public raiden sent transfer info object
 */
export function raidenTransfer(state: TransferState): RaidenTransfer {
  const status = transferStatus(state);
  const startedAt = new Date(state.transfer.ts);
  const changedAt = new Date(statusesMap[status](state)!);
  const transfer = state.transfer;
  const direction = state.direction;
  const value = transfer.lock.amount.sub(state.fee);
  const invalidSecretRequest = state.secretRequest && state.secretRequest.amount.lt(value);
  const success =
    state.secretReveal || state.unlock || state.secretRegistered
      ? true
      : invalidSecretRequest || state.expired || state.channelClosed
      ? false
      : undefined;
  const completed = transferCompleted(state);
  return {
    key: transferKey(state),
    secrethash: transfer.lock.secrethash,
    direction,
    status,
    initiator: transfer.initiator,
    partner: state.partner,
    target: transfer.target,
    metadata: transfer.metadata,
    paymentId: transfer.payment_identifier,
    chainId: transfer.chain_id.toNumber(),
    token: transfer.token,
    tokenNetwork: transfer.token_network_address,
    channelId: transfer.channel_identifier,
    value,
    fee: state.fee,
    amount: transfer.lock.amount,
    expirationBlock: transfer.lock.expiration.toNumber(),
    startedAt,
    changedAt,
    success,
    completed,
    secret: state.secret,
  };
}

/**
 * Look for a BalanceProof matching given balanceHash among EnvelopeMessages in transfers
 *
 * @param db - Database instance
 * @param channel - Channel key of hash
 * @param direction - Direction of transfers to search
 * @param balanceHash - Expected balanceHash
 * @returns BalanceProof matching balanceHash or undefined
 */
export function findBalanceProofMatchingBalanceHash$(
  db: RaidenDatabase,
  channel: Channel,
  direction: Direction,
  balanceHash: Hash,
) {
  if (balanceHash === HashZero) return of(BalanceProofZero);
  return defer(() =>
    // use db.storage directly instead of db.transfers to search on historical data
    db.find({ selector: { channel: channelUniqueKey(channel), direction } }),
  ).pipe(
    mergeMap(({ docs }) => from(docs as TransferStateish[])),
    mergeMap((doc) => {
      const transferState = decode(TransferState, doc);
      return from([transferState.transfer, transferState.unlock, transferState.expired]);
    }),
    filter(isntNil),
    map(getBalanceProofFromEnvelopeMessage),
    // will error observable if none matching is found
    first((bp) => createBalanceHash(bp) === balanceHash),
  );
}

/**
 * @param state - RaidenState or Observable of RaidenState to get transfer from
 * @param db - Try to fetch from db if not found on state
 * @param key - transferKey/_id to get
 * @returns Promise to TransferState
 */
export async function getTransfer(
  state: RaidenState | Observable<RaidenState>,
  db: RaidenDatabase,
  key: string | { secrethash: Hash; direction: Direction },
): Promise<TransferState> {
  if (typeof key !== 'string') key = transferKey(key);
  if (!('address' in state)) state = await state.pipe(first()).toPromise();
  if (key in state.transfers) return state.transfers[key];
  return decode(TransferState, await db.get<TransferStateish>(key));
}

// a very simple/small subset of Metadata, to be used only to ensure metadata.routes[*].route array
// the t.exact wrapper ensure unlisted properties are removed after decoding
const RawMetadataCodec = t.exact(
  t.type({
    routes: t.array(t.exact(t.type({ route: t.array(t.string), address_metadata: t.unknown }))),
  }),
);

/**
 * Prune metadata route without changing any of the original encoding
 * A clear metadata route have partner (address after ours) as first hop in routes[*].route array.
 * To be used only if partner requires !Capabilities.IMMUTABLE_METADATA
 *
 * @param address - Our address
 * @param metadata - Metadata object
 * @returns A copy of metadata with routes cleared (i.e. partner as first/next address)
 */
export function clearMetadataRoute<M extends unknown | Metadata>(
  address: Address,
  metadata: M,
): M {
  let decoded;
  try {
    decoded = decode(RawMetadataCodec, metadata);
  } catch (e) {
    return metadata; // if metadata isn't even RawMetadataCodec, just return it
  }
  const lowercaseAddr = address.toLowerCase();
  return {
    ...decoded, // just for consistency, t.exact above will remove any property but 'routes'
    routes: decoded.routes.map(({ route, ...rest }) => ({
      ...rest,
      route: route.slice(route.findIndex((a) => a.toLowerCase() === lowercaseAddr) + 1),
    })),
  } as M;
}

/**
 * Contructs transfer.request's payload paramaters from received PFS's Paths
 *
 * @param paths - Paths array coming from PFS
 * @returns Respective members of transfer.request's payload, with stricter 'metadata'
 */
export function metadataFromPaths(
  paths: Paths,
): Pick<transfer.request['payload'], 'fee' | 'partner' | keyof Via> & { metadata: Metadata } {
  // paths may come with undesired parameters, so map&filter here before passing to metadata
  const routes = paths.map(({ path: route, fee: _, address_metadata }) => ({
    route,
    ...(address_metadata && !isEmpty(address_metadata) ? { address_metadata } : {}),
  }));
  const viaPath = paths[0];
  const partner = viaPath.path[1]; // we're first address in route, partner is 2nd
  const fee = viaPath.fee;
  const partnerMetadata = searchValidMetadata(viaPath.address_metadata, partner);
  const via: Via = { userId: partnerMetadata?.user_id };

  let metadata: Metadata = { routes };
  // iff partner requires a clear route (to be first address), clear it;
  // in routes received from PFS, we're always first address and partner second
  if (!getCap(parseCaps(partnerMetadata?.capabilities), Capabilities.IMMUTABLE_METADATA))
    metadata = clearMetadataRoute(viaPath.path[0], metadata);

  return { metadata, fee, partner, ...via };
}

/**
 * @param addressMetadata - metadata's address_metadata mapping
 * @param address - Address to search and validate
 * @returns AddressMetadata of given address
 */
export function searchValidMetadata(
  addressMetadata: RouteMetadata['address_metadata'],
  address: Address,
) {
  return validateAddressMetadata(
    // support address_metadata keys being both lowercase and checksummed addresses
    addressMetadata?.[address] ?? addressMetadata?.[address.toLowerCase()],
    address,
  );
}

/**
 * @param metadata - Transfer metadata to search on
 * @param address - Address metadata to search for
 * @returns Via object or undefined
 */
export function searchValidViaAddress(
  metadata: unknown | undefined,
  address: Address | undefined,
): Via | undefined {
  let userId;
  let decoded;
  try {
    decoded = decode(Metadata, metadata);
  } catch (e) {}
  if (!decoded || !address) return;
  for (const { address_metadata } of decoded.routes) {
    if ((userId = searchValidMetadata(address_metadata, address)?.user_id)) return { userId };
  }
}
