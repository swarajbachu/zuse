# Mobile App Store review audit

Historical September 22 findings. See the [September 23 audit and remediation status](app-store-audit-2026-09-23.md) for the current follow-up.

Audited September 22, 2026 against main `06712b592` and this PR. Apple reviewed
version 1.0 (8) on an iPad Air 11-inch (M3) and rejected the camera pre-permission
button under 5.1.1(iv). This is a source audit, not certification of the submitted
binary. App Store Connect fields and device behavior were not inspected.

## Fixed in this PR

- Scanner pre-permission button now says **Continue**. The system owns the actual
  permission decision. Denied access retains a Settings action and close button.
  `apps/mobile/app/connect/scan.tsx`
- Scanner explanation now describes this feature's camera use instead of implying
  that the entire app uses the camera only for scanning. Attachments also use it.
- Onboarding explains camera and local-network use without instructing users to
  grant access. `apps/mobile/src/components/onboarding/onboarding-flow.tsx`
- Settings now exposes the public Privacy Policy when signed in or signed out,
  with a fallback URL if opening fails. `apps/mobile/app/settings.tsx`
- Settings button wording works for both iPhone and the review device's iPad.

## Open findings

| Priority | Evidence and gap | Follow-up |
| --- | --- | --- |
| High | The website privacy policy promises a mobile **Share usage analytics** switch. No such control exists in mobile Settings. `apps/mobile/src/lib/analytics.ts` defaults enabled and resets enabled during hydration. | Implement a persisted mobile choice that stops collection and handles queued events, or reconcile the policy and consent design before resubmission. Do not describe the current app as offering this switch. |
| High | The app privacy manifest lists email, user ID, device ID, and crash data. It does not list product interaction despite screen, control, and active-time events in `src/lib/analytics.ts`. Its identifiers list functionality, but the analytics client also identifies signed-in users pseudonymously. | Reconcile the final binary's aggregated manifests and App Privacy answers with actual collection, purposes, and linkage. Collection is build-config dependent (`EXPO_PUBLIC_POSTHOG_KEY`). Review cloud chat content, attachments, and audio separately; do not assume the manifest is a complete inventory. |
| High | No explicit personal-data sharing disclosure/consent was found in the inspected onboarding, cloud-chat creation, and voice UI. Voice invokes `transcribeVoice` and chat sends user content to remote environments. | Trace actual AI and transcription recipients and any existing hosted consent. Add explicit permission before personal-data sharing where missing, including when the recipient changes. A microphone OS prompt alone does not explain third-party transmission. |
| Medium | Camera attachment denial throws a generic error; voice denial mentions Settings but has no Settings action. `src/lib/composer-attachments.ts`, `src/components/composer-voice-button.tsx`. | Add usable recovery for denied/restricted access and test return from Settings. These are usability findings, not additional Apple-confirmed rejections. |
| Medium | `supportsTablet` is false, but Apple reviewed on iPad. Some onboarding still says phone. | Verify iPhone compatibility mode on iPad: scanner dismissal, safe areas, keyboard, rotation, permission denial, and links. Disabling tablet layout does not establish review-device readiness. |

The policy source is `apps/web/app/(default)/privacy/page.tsx`; the manifest is
`apps/mobile/ios/ZuseMobile/PrivacyInfo.xcprivacy`. The privacy URL redirected to
`https://www.zuse.sh/privacy` and returned HTTP 200 during this audit.

## Existing implementation to verify in the release build

- In-app account deletion exists in Settings and reports pending remote cleanup
  separately from local cleanup failures. Exercise it with a disposable account;
  a source-level delete button does not establish server deletion success.
- Camera, photo library, microphone, and local network purpose strings exist in
  `app.json`. Compare with the archived Info.plist and test actual prompts.
- Image selection uses a system picker without an explicit broad library request.
  Camera and microphone requests originate from their feature actions.
- Notifications are optional in the registration helper; denial returns no token.
  Test that core workflows continue after denial.
- Local pairing and cloud sign-in are separate onboarding paths. Confirm local
  workflows remain usable without an account and without unrelated permissions.
- Session replay and automatic lifecycle capture are disabled in the analytics
  client. No ATT request was found. Inspect actual SDK/network behavior before
  deciding whether cross-company tracking occurs; analytics alone is not proof.

## Submission checklist

Apply the relevant sections of [Apple's review guidelines](https://developer.apple.com/app-store/review/guidelines/):

- **5.1.1–5.1.2:** accessible policy, truthful disclosures, minimal access,
  consent/withdrawal, deletion, and explicit permission for personal-data sharing
  with third-party AI.
- **2.1:** working backend and reviewer access, including a durable way to exercise
  pairing and cloud features.
- **2.3:** accurate screenshots, description, age rating, support links, and privacy
  answers for the actual submitted build.
- **2.4–2.5:** supported-device behavior, public APIs, appropriate background modes,
  and execution architecture.
- **3.1:** determine the applicable companion/service billing category and audit
  hosted signup and purchase links by storefront.
- **4.8:** inspect hosted authentication options and any applicable login exception.
- **4.2.7 / 4.7:** assess applicability to remote execution; do not assume a native
  agent client is a screen-streaming remote desktop or mini-app platform.
- **1.2 / 5.2:** assess content/reporting obligations and third-party service rights.

See also [Apple's privacy design guidance](https://developer.apple.com/design/human-interface-guidelines/privacy).

Operational checks before resubmission:

1. Resolve the open privacy findings above and record verification evidence.
2. Test fresh install, grant, deny, restricted access, Settings return, close, and
   successful scanning on iPhone and iPad compatibility mode. Test attachment,
   dictation, photo selection, and notifications separately.
3. Run an iOS production export and signed build. Inspect aggregated privacy
   manifests, SDK declarations, entitlements, encryption answers, and build number.
4. Verify live hosted login options, account deletion, cloud availability, support
   and policy links, and every reviewer instruction. A five-minute QR code alone
   is not a durable review setup.
5. Check App Store Connect privacy answers, age rating, screenshots, metadata,
   contact details, reviewer credentials, and selected build. These remain unverified.
6. Upload/select a new build and reply to Apple with the corrected scanner path and
   button wording. This PR does not upload, submit, or merge a release.
