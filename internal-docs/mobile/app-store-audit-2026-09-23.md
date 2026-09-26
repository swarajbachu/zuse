# Mobile App Store readiness audit — September 23, 2026

Audited source: `24788f75c9591b930f8e8d1f4175167cd1351a38`. This expands the
[September 22 checklist](app-store-review-checklist.md) with native configuration,
deletion, push and release-readiness findings. The original findings below describe the audited baseline. The remediation status
in the following section supersedes its implementation statuses.

Apple reviewed 1.0 (8) on iPad Air 11-inch (M3), submission
`1f8f3fde-4682-43d1-9e0f-d590b4542534`. The supplied rejection identifies only the
camera pre-permission button under 5.1.1(iv). Other findings below are our audit
findings, not additional Apple rejection notices.

**Decision: not ready to declare complete compliance.** The camera button is
already Continue in this checkout, but multiple other source gaps remain. The
signed build, App Store Connect fields, hosted login and device behavior were not
inspected. This report does not establish what shipped in build 8.

## Remediation in the stacked changes

- **Findings 1 and 6:** mobile analytics now defaults off, has a persisted Settings
  switch, stops activity tracking and discards pending memory-queue events on
  withdrawal. The privacy manifest adds product interaction and analytics purposes
  for identifiers and marks reliability data linked. Production network/SDK and
  App Store label reconciliation still requires the archive.
- **Finding 2:** new-chat, message and dictation actions disclose sharing and ask
  before transmission. Choices are scoped to agent/model and destination for the
  app session, can be reset in Settings, and are cleared on sign-out/reset.
  Previously accepted work can continue; resetting choices does not recall it.
- **Finding 3:** reset/deletion clears draft memory, persisted drafts and protected
  attachment files, invalidates stale hydration and drains in-flight saves.
- **Finding 4:** sign-out/reset revokes the registered device before dropping auth,
  unregisters native notifications, dismisses delivered alerts and clears device
  identity. If revocation fails, sign-out retains the session and asks the user to
  reconnect and retry. Offline sign-out is deliberately not reported as complete.
- **Findings 5 and 9:** native camera text matches scanning and attachment capture;
  camera/microphone denial offers Settings and an alternative. Notification wording
  uses device-neutral language.
- **Finding 7:** new notifications open the inbox; old computer links are remapped.
  Notification handlers reject arbitrary external destinations.
- **Finding 8:** development/production APNs entitlements are declared in both the
  native project and Expo config. Signing profiles and actual delivery remain to
  be verified on the replacement archive/device.
- **Finding 10:** removed the blanket encryption-exemption flag. The submission
  must answer the encryption questionnaire using the bundled AES-GCM/X25519 and
  distribution territories. No exemption or declaration is asserted by these PRs.
- **Finding 11:** the user-confirmed private address, `hi@zuse.sh`, is linked in
  mobile Settings, the Privacy Policy and the Data Rights page. Website deployment
  and the App Store Support URL update are separate release steps.
- **Finding 12:** push payloads use generic Zuse titles and omit environment labels.

### Required release-owner checks

These cannot be settled by changing app source and must not be marked passed by
merging these changes:

1. App Store Connect privacy categories/purposes/linkage, age rating, screenshots,
   selected build, reviewer credentials, Support URL and review notes.
2. Production hosted login options and applicability of 4.8; companion/cloud
   billing classification and applicable storefront purchase rules.
3. Third-party integration authorization and the transcription service's terms.
4. Encryption questionnaire/declarations, signed APNs entitlement/profile and SDK
   privacy report from the actual archive.
5. Real iPhone/iPad grant/deny/Settings-return, notifications, account deletion and
   reviewer-access tests. The iPhone-only target still needs iPad compatibility QA.

Local validation: mobile tests, mobile/API type checks, focused API integration
and push-privacy tests, changed-file Biome, plist validation and whitespace checks.
See the PR descriptions for final run counts and any export/build limitations.

## Prioritized findings

### 1. Analytics choice promised by policy is missing — high, confirmed

`apps/mobile/src/lib/analytics.ts:29,154` defaults and resets analytics to enabled.
The client records screens, controls and activity and identifies signed-in users
pseudonymously. Settings has no persisted opt-out. Collection depends on
`EXPO_PUBLIC_POSTHOG_KEY` and build mode. The live [privacy policy](https://www.zuse.sh/privacy)
nevertheless promises “Share usage analytics” in mobile Settings.

Implement the promised choice, stop collection/timers when disabled and handle
queued SDK events. Verify consent before first collection. Relevant area: 5.1.1.

### 2. AI/voice sharing has no explicit mobile consent step — high, source gap

No sharing-consent step was found in inspected onboarding, new-chat, cloud-auth
or composer flows. `apps/mobile/src/components/composer-voice-button.tsx:159`
uploads recorded bytes through `voice.transcribe`;
`apps/server/src/voice/handlers.ts:24,128` forwards them to a third-party
transcription endpoint. The microphone purpose text only describes dictation.

Disclose recipients and data, then obtain explicit permission before transmission.
Cover prompts, files, images and audio, provider changes and fallback paths. Check
any existing hosted consent before deciding what can be reused. Relevant area:
5.1.2(i).

### 3. Reset/deletion omits saved composer drafts and attachments — high, confirmed source omission

`apps/mobile/src/lib/mobile-data.ts:45` clears offline cache and connections.
`clearConnections()` correctly clears downloaded media too. However, reset omits
the separate `zuse-composer-drafts` and `zuse-outbox-media` roots and keep-alive
draft atom. See `store/composer-drafts.ts:36` and
`lib/composer-attachment-storage.ts:11`. Both account deletion and Reset app use
this function; resetting the outbox only drains writes and clears its own atom.

Add shared cleanup for drafts, pending writes and protected attachments. Test
unsent text/images → reset/delete → relaunch. This conflicts with the reset promise;
it does not prove remote account deletion fails.

### 4. Sign-out leaves server push registration active — high, confirmed source omission

`apps/mobile/src/store/auth.ts:69` clears local authentication but does not revoke
the registered server device. `infra/api/src/handler.ts:1135` sends to registered
devices. Even Reset app's `clearPushRegistration()` only clears the local device ID.

Revoke account-bound registration before dropping auth, with offline retry
behavior. Test account A → sign-out → B: no A alerts, B registration succeeds.
The store rejects a device ID owned by another account, so retained identity also
affects account switching.

### 5. Native camera purpose text is stale — medium, confirmed

`apps/mobile/ios/ZuseMobile/Info.plist:49` describes pairing-code scanning only;
`app.json` also describes attachment photos. The composer actually takes photos.
The native iOS project is checked in, so Expo config alone does not establish the
archived prompt. Synchronize both and inspect the built plist. Relevant area: 5.1.1.

### 6. Privacy manifest does not match the analytics inventory — high, source gap

`apps/mobile/ios/ZuseMobile/PrivacyInfo.xcprivacy:32` lists email, user ID, device ID
and crash data, but no product interaction. Identifier purposes list functionality
while analytics also uses identifiers. Crash data is marked unlinked; reconcile
that with account-derived analytics identity for actual reliability events.

Inspect the combined archive report and production network behavior. Reconcile
App Store labels, data purposes and linkage. Assess cloud content, photos/files
and audio separately, including retention and disclosure exceptions. This does
not establish that the unseen App Store answers are wrong.
[Apple App Privacy details](https://developer.apple.com/app-store/app-privacy-details/).

### 7. Notification taps point to a removed route — medium, confirmed source mismatch

`infra/api/src/handler.ts:1145` emits `zuse://computers?environmentId=...`.
`apps/mobile/src/notifications/push.ts` opens it directly. No `app/computers.tsx`
or native-intent redirect exists; `_layout.tsx` only remaps legacy pairing URLs.
Use a current destination and test cold/warm notification taps. Relevant area: 2.1.

### 8. Release push entitlement is missing from source — high, archive verification

`ios/ZuseMobile/ZuseMobile.entitlements` has only keychain groups. Release uses
this file; no `aps-environment` appears in the checked-in native configuration.
An Expo notifications plugin is configured, but that does not prove it updates
this native archive. Inspect signed entitlements/provisioning and deliver a real
release-device notification before calling push supported.
[Apple entitlement reference](https://developer.apple.com/documentation/bundleresources/entitlements/aps-environment).

### 9. Permission-denial recovery is inconsistent — medium, confirmed UX gap

Scanner denial offers Settings. Attachment-camera denial throws a generic error
(`composer-attachments.ts:44`); voice denial mentions Settings without an action
(`composer-voice-button.tsx:240`). Notification denial says iPhone Settings on iPad.
Add recovery and test returning from Settings.

The Settings row “Enable notifications” directly opens the system request. Neutral
wording would reduce review ambiguity, but this is not the rejected custom camera
explainer and is not an Apple-confirmed violation.

### 10. Encryption exemption needs evidence — high, external verification

Both configs set `ITSAppUsesNonExemptEncryption=false`. Mobile actively uses bundled
AES-GCM and X25519 (`lib/pairing-device-key.ts`), beyond OS HTTPS. This does not
automatically make the flag incorrect. Complete the encryption questionnaire for
the actual crypto and territories; record the exemption/declaration basis,
including France if applicable.
[Apple encryption documentation matrix](https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/).

### 11. No published private privacy-request channel — medium, operational gap

The live policy explicitly says there is no dedicated private privacy-request
address and discourages account-specific requests in its public community channels.
Settings Help only offers onboarding. Publish an operational private support/rights
route and verify the App Store Support URL. This is not a claim that Apple mandates
a specific email-address format. [Current policy](https://www.zuse.sh/privacy).

### 12. Push payload includes environment labels — medium, privacy risk

`apps/server/src/api/activity-publisher.ts:70` sends `config.label` as title;
`infra/api/src/push.ts:44,49` forwards it to the push service and visible alert.
This is a computer/environment label, not evidence of chat-text transmission.
Private names can still appear there. Prefer generic alerts and fetch detail after
opening/authentication. Relevant area: 4.5.4.

## Full applicability checklist for this app

Present means source support, not release acceptance. Verify means evidence is
still needed. References are to [Apple's review guidelines](https://developer.apple.com/app-store/review/guidelines/).

| Area | Status | Remaining evidence/action |
| --- | --- | --- |
| Camera explainer / 5.1.1(iv) | Present: Continue | Replacement build includes it; grant/deny tests |
| In-app privacy policy / 5.1.1(i) | Present in signed-in/out Settings | Accurate policy and App Store URL |
| Analytics choice | Missing | Finding 1 |
| AI sharing permission | Source gap | Finding 2 |
| Account deletion / 5.1.1(v) | UI and API present | Disposable-account test including 202 cleanup and identity removal |
| Local reset/deletion | Incomplete | Finding 3 |
| Logout/account isolation | Incomplete | Finding 4; offline logout and account switch |
| Camera purpose text | Native/config drift | Finding 5 |
| Microphone purpose text | Present | Actual prompt, cancel, background stop and sharing consent |
| Photos minimization | System picker present | Limited access, cancellation and supported image formats |
| Local network | Purpose/Bonjour declarations present | Real pairing, denial and manual connection |
| Optional notifications | No core-use gate found | Deny permission and continue core workflows |
| Login-free local use | Present | Fresh install → pairing → chat without account |
| App Privacy labels | Unverified | Finding 6; actual production inventory |
| Required-reason APIs and SDKs | App manifest present | Combined archive report, SDK versions/signatures/reasons |
| ATT | No request/ad SDK found in inspected flows | Verify no cross-company tracking; analytics alone is not proof |
| Notification behavior | Partial | Findings 4, 7, 8, 9, 12 |
| iPad / 2.4 | Unverified | iPhone-only target; test compatibility on review iPad |
| Rotation/keyboard/safe areas | Unverified | Portrait native plist and terminal orientation changes |
| Accessibility / 4.1 | Some labels present | VoiceOver, text scaling, contrast, icon buttons and dismissal |
| Completeness / 2.1 | Source only | Cold launch, offline/reconnect, expired auth, backend errors, chat/files/terminal |
| Reviewer access / 2.1 | External | Durable demo account/environment and pairing resources |
| Screenshots/description / 2.3 | External | Match actual submitted UI, cloud and voice features |
| Age rating | External | Questionnaire reflecting AI, web links and content access |
| Primary login / 4.8 | Hosted AuthKit; options unknown | Production sign-up/login and equivalent option or exception |
| Payments / 3.1 | No native purchase UI found | Companion classification, paid cloud access and hosted storefront flows |
| Purchase restoration | Conditional | Implement if applicable purchases are offered |
| Execution / 2.5.2 | Remote runtime/native terminal | Explain boundary; inspect embedded WebViews and native bridge |
| Remote desktop / 4.2.7 | Applicability unresolved | Agent client is not automatically a screen-mirroring product |
| Chatbots/software / 4.7 | Applicability unresolved | Review provider/agent architecture and extra obligations if applicable |
| Shared content / 1.2 | No public social feed found in inspected flow | Reassess filtering/reporting/blocking for shared content or 4.7 |
| Provider rights / 5.2 | Unverified | Authorization/reliability of token-based and transcription integrations |
| Export compliance | Unverified | Finding 10 |
| Support/contact | Partial | Finding 11 and working App Store Support URL |
| Capabilities/background/public APIs | Partial source inspection | Archive inspection and no unnecessary/debug behavior |
| Distribution metadata | External | Selected build, agreements, territories/trader status as applicable, review contact |

No evidence was found in the inspected mobile scope of HealthKit, HomeKit,
gambling, financial trading, advertising or Kids-category functionality. Their
specialized requirements are not presumed applicable. This does not certify every
transitive SDK or connected service.

Additional primary references:

- [Permission UI guidance](https://developer.apple.com/design/human-interface-guidelines/privacy)
- [Account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [SDK privacy/signature requirements](https://developer.apple.com/support/third-party-SDK-requirements/)
- [Tracking/data-use guidance](https://developer.apple.com/app-store/user-privacy-and-data-use/)
- [Age-rating configuration](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/)

## Resubmission gates

1. Address confirmed privacy, cleanup, prompt and routing gaps; run focused
   behavior tests, mobile type checks and Biome after implementation.
2. Inspect the production archive: purpose strings, signed entitlements, privacy
   report, encryption answers and build number. TestFlight uses staging while the
   production EAS profile uses production; verify the selected review build.
3. Test fresh install, permission denial/Settings return, pairing, manual access,
   attachments, dictation, login/logout, deletion, push delivery/taps on iPhone
   and review iPad, including interrupted networks and cold starts.
4. Verify hosted login, cloud billing classification, provider rights, support and
   durable reviewer access. Reconcile App Store metadata/privacy/age-rating answers.
5. Select the replacement build and reply to Apple with scanner path and corrected
   wording after release validation.

Original audit validation: source inspection and live Apple documentation/public
policy. The remediation section records the subsequent implementation checks. No signed build, device, hosted login or App Store
Connect inspection was performed. The stacked PRs do not deploy the website/API or submit a new App Store build.
