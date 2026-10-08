using VContainer;
using VContainer.Unity;
using Game.Farming;
using Game.Staff;
using Game.UI;

namespace Game.Core
{
    public class GameLifetimeScope : LifetimeScope
    {
        [SerializeField] private FarmScreen farmScreen;
        [SerializeField] private GameRoot root;

        protected override void Configure(IContainerBuilder builder)
        {
            builder.Register<TimeService>(Lifetime.Singleton).As<ITimeService>();
            builder.Register<CropService>(Lifetime.Singleton);
            builder.Register<InventoryService>(Lifetime.Singleton).AsImplementedInterfaces();
            builder.Register<FarmManager>(Lifetime.Singleton);
            builder.Register<HiringService>(Lifetime.Scoped);
            builder.Register<CurrencyService>(Lifetime.Singleton);
            builder.Register<StaffRepository>(Lifetime.Singleton);
            builder.RegisterEntryPoint<FarmController>();
            builder.RegisterComponent(farmScreen);
            builder.RegisterComponent(root.Systems.Weather);
        }
    }
}
