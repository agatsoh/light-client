import type { providers } from 'ethers';

import { ConfigProvider } from '@/services/config-provider';

// The type evaluation for static class members works slightly different for
// the moment. Thereby it is not possible to have any better type restrictions
// here. Though having the named type here in place will allows us to adopt it
// later and being explicit about it at all places.
export type EthereumProviderOptions = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface EthereumProviderFactory {
  providerName: string;
  isAvailable: boolean;
  isDisabled: () => Promise<boolean>;
  link: (options: EthereumProviderOptions) => Promise<EthereumProvider>;
}

// TOOD: watch-out when `static abstract` becomes possible in TypeScript
export abstract class EthereumProvider {
  static providerName: string;
  static isAvailable = false;
  static link: (options: EthereumProviderOptions) => Promise<EthereumProvider>;

  abstract provider: providers.JsonRpcProvider;
  abstract account: string | number;

  constructor() {
    const isAvailable = (this.constructor as typeof EthereumProvider).isAvailable;

    if (!isAvailable) {
      throw new Error('The provider is not available.');
    }
  }

  static async isDisabled(): Promise<boolean> {
    const configuration = await ConfigProvider.configuration();
    const disabled_ethereum_providers = configuration.disabled_ethereum_providers ?? [];
    return disabled_ethereum_providers.includes(this.providerName);
  }
}
