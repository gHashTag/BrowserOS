diff --git a/ui/views/widget/widget_unittest.cc b/ui/views/widget/widget_unittest.cc
index 9467ff86dfabb..b6d136d5f27bc 100644
--- a/ui/views/widget/widget_unittest.cc
+++ b/ui/views/widget/widget_unittest.cc
@@ -264,6 +264,14 @@ TEST_F(WidgetTest, WidgetInitParams) {
   EXPECT_EQ(Widget::InitParams::WindowOpacity::kInferred, init1.opacity);
 }
 
+TEST_F(WidgetTest, HeadlessInitParamDefaultsFalse) {
+  Widget::InitParams params(Widget::InitParams::CLIENT_OWNS_WIDGET,
+                            Widget::InitParams::TYPE_WINDOW);
+  EXPECT_FALSE(params.headless);
+  params.headless = true;
+  EXPECT_TRUE(params.headless);
+}
+
 // Tests that the internal name is propagated through widget initialization to
 // the native widget and back.
 class WidgetWithCustomParamsTest : public WidgetTest {
