import ExpoModulesCore
import Photos
import QuickLook
import UIKit

public final class ZuseMobilePlatformModule: Module, @unchecked Sendable {
  private var quickLookCoordinator: ZuseQuickLookCoordinator?
  private var backgroundTasks: [Int: UIBackgroundTaskIdentifier] = [:]
  private var nextBackgroundTaskId = 1

  public func definition() -> ModuleDefinition {
    Name("ZuseMobilePlatform")

    AsyncFunction("beginBackgroundTask") { () async -> Int in
      await MainActor.run {
        let id = self.nextBackgroundTaskId
        self.nextBackgroundTaskId += 1
        let task = UIApplication.shared.beginBackgroundTask(
          withName: "Voice transcription"
        ) { [weak self] in
          DispatchQueue.main.async { [weak self] in
            guard
              let task = self?.backgroundTasks.removeValue(forKey: id)
            else {
              return
            }
            UIApplication.shared.endBackgroundTask(task)
          }
        }
        if task != .invalid {
          self.backgroundTasks[id] = task
          return id
        }
        return 0
      }
    }

    AsyncFunction("endBackgroundTask") { (id: Int) async -> Void in
      await MainActor.run {
        guard let task = self.backgroundTasks.removeValue(forKey: id) else {
          return
        }
        UIApplication.shared.endBackgroundTask(task)
      }
    }

    AsyncFunction("saveImageToPhotos") { (uri: String) async throws -> Bool in
      guard let url = URL(string: uri), url.isFileURL else {
        return false
      }
      let status = await withCheckedContinuation { continuation in
        PHPhotoLibrary.requestAuthorization(for: .addOnly) {
          continuation.resume(returning: $0)
        }
      }
      guard status == .authorized || status == .limited else {
        return false
      }
      try await PHPhotoLibrary.shared().performChanges {
        PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url)
      }
      return true
    }

    Function("presentQuickLook") { (uri: String) -> Bool in
      guard
        let url = URL(string: uri),
        let presenter = self.appContext?.utilities?.currentViewController()
      else {
        return false
      }
      let coordinator = ZuseQuickLookCoordinator(url: url)
      self.quickLookCoordinator = coordinator
      DispatchQueue.main.async {
        let controller = QLPreviewController()
        controller.dataSource = coordinator
        controller.delegate = coordinator
        presenter.present(controller, animated: true)
      }
      return true
    }
  }
}

private final class ZuseQuickLookCoordinator: NSObject,
  QLPreviewControllerDataSource,
  QLPreviewControllerDelegate
{
  private let url: URL

  init(url: URL) {
    self.url = url
  }

  func numberOfPreviewItems(
    in controller: QLPreviewController
  ) -> Int {
    1
  }

  func previewController(
    _ controller: QLPreviewController,
    previewItemAt index: Int
  ) -> QLPreviewItem {
    url as NSURL
  }
}
