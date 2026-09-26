zuse_license = File.expand_path('../../../../LICENSE', __dir__)

Pod::Spec.new do |s|
  s.name           = 'ZuseMobileTerminal'
  s.version        = '1.0.0'
  s.summary        = 'Native terminal surface for paired development environments.'
  s.description    = 'Expo view bridge for rendering and interacting with an authenticated remote PTY.'
  s.author         = 'Zuse'
  s.homepage       = 'https://zuse.sh'
  s.license        = { :type => 'AGPL-3.0-only', :text => File.read(zuse_license) }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
  s.source_files = 'ios/**/*.{c,h,m,mm,swift}'
  s.public_header_files = 'ios/ZuseGhosttySupport.h'
  s.exclude_files = 'ios/Tests/**/*'
  s.vendored_frameworks = 'Vendor/GhosttyVt.xcframework'
  s.preserve_paths = 'Vendor/GhosttyVt.LICENSE'
  s.resource_bundles = {
    'ZuseMobileTerminalLicenses' => ['Vendor/GhosttyVt.LICENSE']
  }
  s.pod_target_xcconfig = {
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) GHOSTTY_STATIC=1'
  }

  s.test_spec 'Tests' do |ts|
    ts.source_files = 'ios/Tests/**/*.swift'
  end
end
