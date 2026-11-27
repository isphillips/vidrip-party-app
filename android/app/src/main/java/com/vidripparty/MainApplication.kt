package com.vidripparty

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    // Push: the default channel (minSdk is 26, so channels always exist). Id matches the manifest's FCM default.
    getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel("default", "Vidrip Party", NotificationManager.IMPORTANCE_DEFAULT))
    // Friend requests, invites, messages: a pop-up with sound (a channel's importance cannot be raised after it exists, so this is a new one).
    getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel("alerts", "Friends and invites", NotificationManager.IMPORTANCE_HIGH))
  }
}
