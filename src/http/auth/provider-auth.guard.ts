import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

export interface ProviderIdentity {
  subject: string;
  /** Provider the caller is allowed to act as (e.g. JWT claim `provider_id`). */
  providerId?: string;
}

/**
 * Extension point for authentication. Authentication is intentionally NOT implemented in
 * this challenge (see ARCHITECTURE.md §Autenticação). A real implementation would validate
 * an OIDC access token issued by Keycloak (client-credentials, one client per provider) and
 * return the `provider_id` claim, which the controller then compares with the payload's
 * providerId.
 */
export interface ProviderIdentityPort {
  resolve(request: Request): Promise<ProviderIdentity | undefined>;
}

/** No-op adapter: every caller is trusted. */
export class TrustAllProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return { subject: 'anonymous' };
  }
}

export type AuthenticatedRequest = Request & { providerIdentity?: ProviderIdentity };

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.identity.resolve(request);
    if (!identity) return false;
    request.providerIdentity = identity;
    return true;
  }
}
